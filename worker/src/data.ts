// Sharded / lazy-load data for the worker (DESIGN-sharding.md).
//
// The full graph (37 MB) + search index (18.5 MB) are too large for the
// free-tier Worker to load at cold start (128 MB memory). So the data lives
// in R2 as small pieces and the Worker loads only what a query needs:
//
//   catalog.json   (~1.9 MB)  meta + sections + trending + per-section tops
//                             + skeleton (non-item nodes + edges among them)
//   termmap.json   (~1.1 MB)  term -> [section indices, most relevant first]
//   shards/<slug>.json        one per README section: its item + list nodes,
//                             LISTED_IN edges, and a per-section TF-IDF index
//                             (global idf, postings capped at 20/term/section)
//
// Cold start loads ONLY catalog.json + termmap.json (~3 MB). A search then
// loads the top 3 sections for the query terms (bounded memory) and caches
// them in memory, so repeat queries are fast. Trending / categories /
// health are served from the catalog with no shard fetch.
//
// Fallback: if catalog.json is missing from R2 (an older deployment, or a
// test fixture bucket), the loader falls back to the old full-graph path
// (graph.json + search.json). The worker never crashes on bad data.

import {
  getNode,
  isCatalogLoaded,
  isGraphLoaded,
  loadGraphData,
  loadShard,
  loadSkeleton,
  resetGraphForTesting,
  setCatalogMetaSections,
} from "./graph";
import {
  isTfidfEnabled,
  loadSearchIndex,
  loadShardIndex,
  queryTerms,
  resetSearchIndexForTesting,
} from "./tfidf";
import { contentTerms, catalogCardToAnswerCard, type AnswerCard, type CatalogCard } from "./retrieval";

/** Minimal structural type for an R2 bucket (the real R2Bucket satisfies it). */
export type R2BucketLike = {
  get(key: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> } | null>;
};

export type DataStatus = {
  graph: boolean;
  search: boolean;
  /** True when the sharded catalog (not the full graph) is loaded. */
  sharded: boolean;
  /** Section slugs whose shards are currently loaded. */
  shards: string[];
};

export type Catalog = {
  version: number;
  meta: Record<string, unknown>;
  sections: { name: string; listCount: number; itemCount: number }[];
  trending: CatalogCard[];
  topBySection: Record<string, CatalogCard[]>;
  skeleton: { nodes: unknown[]; edges: unknown[] };
};

export type Termmap = {
  version: number;
  sections: string[];
  terms: Record<string, number[]>;
};

type GlobalDataState = {
  __graphragDataLoad?: Promise<DataStatus>;
  __graphragCatalog?: Catalog | null;
  __graphragTermmap?: Termmap | null;
  __graphragShards?: Set<string>;
};
const G = globalThis as unknown as GlobalDataState;

/** Max sections loaded for one query (bounded memory; see DESIGN-sharding.md). */
export const MAX_SHARDS_PER_QUERY = 3;

/**
 * Section slug. MUST match scripts/build_shards.py `slugify_section`
 * exactly: lowercase, non-alphanumeric runs -> "-".
 */
export function slugifySection(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "other";
}

/** The loaded catalog, or null when the sharded path is not in use. */
export function getCatalog(): Catalog | null {
  return G.__graphragCatalog ?? null;
}

/** The loaded term-map, or null when the sharded path is not in use. */
export function getTermmap(): Termmap | null {
  return G.__graphragTermmap ?? null;
}

/** True when the sharded catalog is loaded (production path). */
export function isSharded(): boolean {
  return G.__graphragCatalog !== null && G.__graphragCatalog !== undefined;
}

/** Section slugs whose shards are currently loaded in this isolate. */
export function loadedShards(): string[] {
  return [...(G.__graphragShards ?? new Set<string>())];
}

/** Current load status (no fetching). */
export function dataStatus(): DataStatus {
  return {
    graph: isGraphLoaded() || isCatalogLoaded(),
    search: isTfidfEnabled(),
    sharded: isSharded(),
    shards: loadedShards(),
  };
}

function validateCatalog(raw: unknown): Catalog | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (c.version !== 1) return null;
  if (typeof c.meta !== "object" || c.meta === null) return null;
  if (!Array.isArray(c.sections) || !Array.isArray(c.trending)) return null;
  if (typeof c.topBySection !== "object" || c.topBySection === null) return null;
  if (typeof c.skeleton !== "object" || c.skeleton === null) return null;
  const sk = c.skeleton as Record<string, unknown>;
  if (!Array.isArray(sk.nodes) || !Array.isArray(sk.edges)) return null;
  return raw as Catalog;
}

function validateTermmap(raw: unknown): Termmap | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (t.version !== 1) return null;
  if (!Array.isArray(t.sections)) return null;
  if (typeof t.terms !== "object" || t.terms === null) return null;
  return raw as Termmap;
}

/**
 * Idempotent cold-start loader. Loads catalog.json + termmap.json in
 * parallel; falls back to the old graph.json + search.json when the catalog
 * is absent. Never throws: a missing bucket / object / invalid JSON just
 * leaves that feature disabled.
 */
export function ensureData(env: unknown): Promise<DataStatus> {
  if (!G.__graphragDataLoad) {
    G.__graphragDataLoad = loadOnce(env);
  }
  return G.__graphragDataLoad;
}

async function loadOnce(env: unknown): Promise<DataStatus> {
  const bucket = (env as { DATA?: R2BucketLike } | null | undefined)?.DATA;
  if (!bucket || typeof bucket.get !== "function") return dataStatus();
  // Sharded path first.
  try {
    const [catObj, tmObj] = await Promise.all([
      bucket.get("catalog.json"),
      bucket.get("termmap.json"),
    ]);
    if (catObj && tmObj) {
      const catalog = validateCatalog(await catObj.json());
      const termmap = validateTermmap(await tmObj.json());
      if (catalog && termmap) {
        G.__graphragCatalog = catalog;
        G.__graphragTermmap = termmap;
        if (!G.__graphragShards) G.__graphragShards = new Set<string>();
        setCatalogMetaSections(catalog.meta, catalog.sections);
        loadSkeleton(catalog.skeleton);
        return dataStatus();
      }
    }
  } catch {
    // fall through to the legacy full-graph path
  }
  // Legacy path (old R2 layout / test fixtures): full graph + index.
  try {
    const obj = await bucket.get("graph.json");
    if (obj) {
      const raw = await obj.json();
      loadGraphData(raw);
    }
  } catch {
    // missing/invalid graph.json -> graph features disabled, never a crash
  }
  try {
    const obj = await bucket.get("search.json");
    if (obj) {
      const raw = await obj.json();
      loadSearchIndex(raw);
    }
  } catch {
    // missing/invalid search.json -> TF-IDF disabled, never a crash
  }
  return dataStatus();
}

/**
 * Which sections a query should load, most relevant first (top
 * MAX_SHARDS_PER_QUERY). Pure: reads the loaded term-map only.
 * Returns [] when the term-map is absent or no term matches.
 */
export function sectionsForQuery(question: string): string[] {
  const termmap = getTermmap();
  if (!termmap) return [];
  const terms = contentTerms(queryTerms(question));
  const scores = new Map<number, number>();
  for (const t of terms) {
    const secs = termmap.terms[t];
    if (!secs) continue;
    secs.forEach((s, rank) => {
      // earlier in the list = more postings for this term = more relevant
      scores.set(s, (scores.get(s) ?? 0) + (secs.length - rank));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SHARDS_PER_QUERY)
    .map(([idx]) => termmap.sections[idx])
    .filter((s): s is string => typeof s === "string");
}

/** Load the given sections' shards from R2 (parallel, cached in memory).
 *  Returns the slugs actually loaded by this call (already-loaded ones
 *  are skipped). Never throws. */
export async function ensureSections(env: unknown, sections: string[]): Promise<string[]> {
  const bucket = (env as { DATA?: R2BucketLike } | null | undefined)?.DATA;
  if (!bucket || typeof bucket.get !== "function") return [];
  if (!G.__graphragShards) G.__graphragShards = new Set<string>();
  const wanted = sections.map((s) => ({ name: s, slug: slugifySection(s) }));
  const missing = wanted.filter((w) => !G.__graphragShards!.has(w.slug));
  if (missing.length === 0) return [];
  const loaded: string[] = [];
  await Promise.all(
    missing.map(async (w) => {
      try {
        const obj = await bucket.get(`shards/${w.slug}.json`);
        if (!obj) return;
        const raw = await obj.json();
        if (typeof raw !== "object" || raw === null) return;
        const shard = raw as { index?: unknown };
        if (!loadShard(raw)) return;
        if (shard.index !== undefined) loadShardIndex(w.slug, shard.index);
        G.__graphragShards!.add(w.slug);
        loaded.push(w.slug);
      } catch {
        // missing/invalid shard -> that section stays unloaded, never a crash
      }
    }),
  );
  return loaded;
}

/** Route a question to sections and load them. No-op when the term-map
 *  is absent (legacy full-graph path) or no term matches. */
export async function ensureSectionsForQuery(env: unknown, question: string): Promise<string[]> {
  const sections = sectionsForQuery(question);
  if (sections.length === 0) return [];
  return ensureSections(env, sections);
}

/**
 * Load the shard(s) containing a node, for /api/expand. A list loads its
 * own section; an item loads the sections its name tokens route to; any
 * other node type needs only the skeleton (already loaded).
 *
 * An item node is NOT in the skeleton (items live only in shards), so
 * looking it up first (getNode) fails on a fresh isolate and the expand
 * returns empty — the chicken-and-egg that made /api/expand return
 * 0 nodes for item ids. For item ids, route by the name in the id
 * itself (item:<name>) without needing the node loaded first.
 */
export async function ensureSectionsForNode(env: unknown, nodeId: string): Promise<string[]> {
  if (nodeId.startsWith("item:")) {
    const name = nodeId.slice("item:".length);
    if (name) return ensureSectionsForQuery(env, name);
    return [];
  }
  const node = getNode(nodeId);
  if (!node) return [];
  if (node.type === "list") {
    const section = node.section ?? "Other";
    return ensureSections(env, [section]);
  }
  if (node.type === "item") {
    const name = node.name ?? nodeId.replace(/^item:/, "");
    return ensureSectionsForQuery(env, name);
  }
  return [];
}

// ---- catalog-backed answers (no shard fetch) ----

/** Trending cards from the catalog (fresh `why`), or null when the
 *  catalog is not loaded. `category` matches a section name; anything
 *  else returns null so the caller can route it to shards instead. */
export function catalogTrending(limit = 10, category?: string): AnswerCard[] | null {
  const catalog = getCatalog();
  if (!catalog) return null;
  const n = Math.max(1, Math.min(50, limit));
  if (!category) {
    return catalog.trending.slice(0, n).map((c) => catalogCardToAnswerCard(c));
  }
  const cat = category.toLowerCase();
  const section = catalog.sections.find((s) => s.name.toLowerCase() === cat)?.name
    ?? catalog.sections.find((s) => s.name.toLowerCase().includes(cat))?.name;
  if (!section) return null;
  return (catalog.topBySection[section] ?? []).slice(0, n).map((c) => catalogCardToAnswerCard(c));
}

/** Section counts from the catalog, or null when it is not loaded. */
export function catalogSections(): { name: string; listCount: number; itemCount: number }[] | null {
  const catalog = getCatalog();
  return catalog ? catalog.sections : null;
}

/**
 * Test-only: clear the loader promise, the catalog/term-map, the shard
 * cache, and the loaded graph + indexes, so a test can load fresh data.
 * Production code never calls this.
 */
export function resetDataForTesting(): void {
  G.__graphragDataLoad = undefined;
  G.__graphragCatalog = null;
  G.__graphragTermmap = null;
  G.__graphragShards = new Set<string>();
  resetGraphForTesting();
  resetSearchIndexForTesting();
}
