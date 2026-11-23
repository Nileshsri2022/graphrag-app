// TF-IDF semantic search (DESIGN-v2.md §4) — free, build-time, no embeddings.
// The index is built at sync time (data agent) and stored as search.json in
// Cloudflare R2 (bucket "graphrag-data"); the worker loads it at cold start
// via `loadSearchIndex` (see src/data.ts `ensureData`):
//   {"version": 1, "terms": {"<term>": {"idf": <float>, "postings": [["<nodeId>", <weight>], ...]}}, "norms": {"<nodeId>": <float>}}
// The index is NOT bundled with the worker. If it is missing or invalid,
// TF-IDF is disabled and search degrades to template matching.
// The worker NEVER crashes on missing/bad search data.

import type { Node } from "./graph";

export type TfIdfIndex = {
  terms: Record<string, { idf: number; postings: [string, number][] }>;
  norms: Record<string, number>;
  /**
   * BM25 data (optional): per-doc token counts + the global average doc
   * length. Written by scripts/build_shards.py into each shard's index
   * (docLens covers exactly the docs in that shard's norms; avgdl is
   * global so BM25 scores stay comparable across shards). Absent in
   * older indexes (and in the legacy global search.json) -> BM25 is
   * unavailable for that index and callers fall back to TF-IDF.
   */
  docLens?: Record<string, number>;
  avgdl?: number;
};

export type TfIdfHit = { id: string; score: number };

/** Query-time synonym expansion (same map the data agent uses at build time). */
export const SYNONYMS: Record<string, string[]> = {
  js: ["javascript"],
  ts: ["typescript"],
  db: ["database"],
  k8s: ["kubernetes"],
  ml: ["machine", "learning"],
  ai: ["artificial", "intelligence"],
  py: ["python"],
};

/** Lowercase alphanumeric tokens, min length 2 (the builder's tokenization). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Query terms: tokenized, with synonym expansions appended after each token. */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(query)) {
    out.push(t);
    const exp = SYNONYMS[t];
    if (exp) out.push(...exp);
  }
  return out;
}

/** Pure index builder (exported for tests; the loader below reads search.json). */
export function buildIndex(docs: { id: string; text: string }[]): TfIdfIndex {
  const n = docs.length;
  const df = new Map<string, number>();
  const perDoc = new Map<string, Map<string, number>>();
  for (const d of docs) {
    const counts = new Map<string, number>();
    for (const t of tokenize(d.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    perDoc.set(d.id, counts);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const terms: TfIdfIndex["terms"] = {};
  const norms: Record<string, number> = {};
  for (const [id, counts] of perDoc) {
    let sq = 0;
    for (const [t, c] of counts) {
      const idf = Math.log(1 + n / (df.get(t) ?? 1));
      const w = (1 + Math.log(c)) * idf;
      (terms[t] ??= { idf, postings: [] }).postings.push([id, w]);
      sq += w * w;
    }
    norms[id] = Math.sqrt(sq);
  }
  for (const entry of Object.values(terms)) entry.postings.sort((a, b) => b[1] - a[1]);
  return { terms, norms };
}

/** Validate raw parsed JSON into an index; null when the shape is wrong. */
export function parseSearchJson(data: unknown): TfIdfIndex | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return null;
  if (typeof d.terms !== "object" || d.terms === null) return null;
  if (typeof d.norms !== "object" || d.norms === null) return null;
  const terms: TfIdfIndex["terms"] = {};
  for (const [term, entry] of Object.entries(d.terms as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.idf !== "number" || !Array.isArray(e.postings)) return null;
    const postings: [string, number][] = [];
    for (const p of e.postings as unknown[]) {
      if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "number") return null;
      postings.push([p[0], p[1]]);
    }
    terms[term] = { idf: e.idf, postings };
  }
  const norms: Record<string, number> = {};
  for (const [id, v] of Object.entries(d.norms as Record<string, unknown>)) {
    if (typeof v !== "number") return null;
    norms[id] = v;
  }
  // BM25 data is optional and lenient: a malformed docLens/avgdl must NOT
  // break the TF-IDF index (old shards and the legacy search.json have
  // neither). Only include them when they are fully valid.
  // CPU (2026-11-23): docLens is trusted data written by our own
  // build_shards.py, so we do NOT validate or copy every entry here.
  // The old loop cost ~4-19ms per large shard on cold load (17k entries)
  // and pushed some requests over the Worker's CPU limit (HTTP 503,
  // error 1102). A non-numeric entry degrades gracefully in bm25Search
  // (a NaN score fails the s > 0 check, so that doc just loses that
  // term's contribution) and can never break TF-IDF, which ignores
  // docLens entirely.
  let docLens: Record<string, number> | undefined;
  if (
    d.docLens !== undefined &&
    typeof d.docLens === "object" &&
    d.docLens !== null &&
    !Array.isArray(d.docLens)
  ) {
    docLens = d.docLens as Record<string, number>;
  }
  let avgdl: number | undefined;
  if (typeof d.avgdl === "number" && Number.isFinite(d.avgdl) && d.avgdl > 0) {
    avgdl = d.avgdl;
  }
  // docLens without a positive avgdl (or vice versa) is unusable for BM25.
  if (docLens === undefined || avgdl === undefined) {
    docLens = undefined;
    avgdl = undefined;
  }
  return { terms, norms, ...(docLens !== undefined ? { docLens, avgdl } : {}) };
}

// ---- loader (explicit: the worker calls loadSearchIndex with the R2 object;
// tests call it with a fixture). Missing/invalid data -> TF-IDF disabled, never a crash. ----
let loadedIndex: TfIdfIndex | null = null;

// ---- sharded indexes (DESIGN-sharding.md) ----
// Each loaded section shard registers its own TF-IDF index (global idf,
// postings capped per term per section). Searches aggregate across all
// loaded shard indexes, so scores stay comparable (same idf + per-doc norms).
const shardIndexes = new Map<string, TfIdfIndex>();

/** Register one section shard's TF-IDF index. False on invalid shape. */
export function loadShardIndex(slug: string, raw: unknown): boolean {
  const idx = parseSearchJson(raw);
  if (!idx) return false;
  shardIndexes.set(slug, idx);
  return true;
}

/** Test-only: clear all registered shard indexes. */
export function resetShardIndexesForTesting(): void {
  shardIndexes.clear();
}

/** Slugs of the shard indexes currently loaded. */
export function loadedShardSlugs(): string[] {
  return [...shardIndexes.keys()];
}

/**
 * All loaded indexes for ranking, in the same priority the search
 * functions use: the shard indexes when sharded, else the single global
 * index. BM25 (src/bm25.ts) searches this list so it stays in lockstep
 * with TF-IDF's data (no separate state to drift).
 */
export function loadedIndexesForSearch(): TfIdfIndex[] {
  if (shardIndexes.size > 0) return [...shardIndexes.values()];
  return loadedIndex ? [loadedIndex] : [];
}

/** True when at least one loaded index carries BM25 data (docLens + avgdl). */
export function isBm25DataLoaded(): boolean {
  return loadedIndexesForSearch().some(
    (idx) => idx.docLens !== undefined && idx.avgdl !== undefined && idx.avgdl > 0,
  );
}

/** Search across every loaded shard index, merged by id (max score wins).
 *  Falls back to the single loaded global index when no shard index exists
 *  (the full-graph / fixture path). */
export function tfidfSearchSharded(query: string, limit = 10): TfIdfHit[] {
  if (shardIndexes.size === 0) return tfidfSearch(query, limit);
  const best = new Map<string, number>();
  for (const idx of shardIndexes.values()) {
    for (const hit of searchWithIndex(idx, query, limit)) {
      const prev = best.get(hit.id);
      if (prev === undefined || hit.score > prev) best.set(hit.id, hit.score);
    }
  }
  return [...best.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/** Load a parsed search.json into the module index. False on invalid shape (state untouched). */
export function loadSearchIndex(raw: unknown): boolean {
  const idx = parseSearchJson(raw);
  if (!idx) return false;
  loadedIndex = idx;
  return true;
}

/** Test-only: clear the loaded index. */
export function resetSearchIndexForTesting(): void {
  loadedIndex = null;
  shardIndexes.clear();
}

/** True when a usable TF-IDF index was loaded (global or any shard). */
export function isTfidfEnabled(): boolean {
  return loadedIndex !== null || shardIndexes.size > 0;
}

/** Pure search over a given index (null index -> no hits, never throws). */
export function searchWithIndex(index: TfIdfIndex | null, query: string, limit = 10): TfIdfHit[] {
  if (!index) return [];
  const terms = [...new Set(queryTerms(query))];
  if (terms.length === 0) return [];
  const scores = new Map<string, number>();
  for (const t of terms) {
    const entry = index.terms[t];
    if (!entry) continue;
    for (const [id, w] of entry.postings) {
      scores.set(id, (scores.get(id) ?? 0) + w);
    }
  }
  const out: TfIdfHit[] = [];
  for (const [id, raw] of scores) {
    const norm = index.norms[id] ?? 0;
    if (norm <= 0) continue;
    out.push({ id, score: raw / norm });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, limit));
}

/** Search over the loaded search.json index (empty when TF-IDF is disabled).
 *  Pass an explicit index (e.g. a test fixture) as the 3rd arg to override. */
export function tfidfSearch(query: string, limit = 10, index: TfIdfIndex | null = loadedIndex): TfIdfHit[] {
  return searchWithIndex(index, query, limit);
}

/** "12.4k" style star formatting. */
export function formatStars(stars: number): string {
  if (stars >= 1000) return `${(stars / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${stars}`;
}

/** "2mo ago" style relative time; "" when the date is missing/invalid. */
export function timeAgo(dateStr: string, now = Date.now()): string {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return "";
  const days = Math.max(0, Math.floor((now - t) / 86_400_000));
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30.44)}mo ago`;
  return `${Math.floor(days / 365.25)}y ago`;
}

/**
 * One-line "why it fits" for an answer card, built ONLY from the node's
 * actual fields — never invented. Example:
 * "Matches 'testing' · Python · ★12.4k · updated 2mo ago"
 */
export function buildWhyText(node: Node, terms: string[]): string {
  const parts: string[] = [];
  // Where each query term matched — name matches are stronger than
  // description matches, and the location differs per card, so the "why"
  // text distinguishes results that share the same rating/freshness
  // (browser defect: all 8 cards showed the identical
  // "Matches 'python' · updated 5d ago"). Terms already matched in the
  // name are not repeated for the description.
  const nameHay = (node.name ?? "").toLowerCase();
  const descHay = (node.description ?? "").toLowerCase();
  const nameHits = terms.filter((t) => t.length >= 2 && nameHay.includes(t));
  const descHits = terms.filter((t) => t.length >= 2 && !nameHay.includes(t) && descHay.includes(t));
  if (nameHits.length > 0) parts.push(`Matches ${nameHits.map((t) => `'${t}'`).join(", ")} in name`);
  if (descHits.length > 0) parts.push(`Matches ${descHits.map((t) => `'${t}'`).join(", ")} in description`);
  if (node.language) parts.push(node.language);
  if (typeof node.stars === "number") parts.push(`★${formatStars(node.stars)}`);
  const last = node.lastActivity ?? node.pushedAt;
  if (last) {
    const ago = timeAgo(last);
    if (ago) parts.push(`updated ${ago}`);
  }
  if (parts.length === 0 && node.description) return node.description.slice(0, 100);
  return parts.join(" · ");
}
