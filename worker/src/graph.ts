// In-memory graph over the repo snapshot.
//
// The graph is NOT bundled with the worker (it is ~13-15 MB; the free Worker
// limit is 1 MB compressed). It is loaded at cold start from Cloudflare R2
// (bucket "graphrag-data", key "graph.json") via `loadGraphData` — see
// src/data.ts `ensureData`. Until loaded, every accessor returns empty
// results and the worker never crashes on missing data. Tests load the
// checked-in fixture (worker/data/graph.json) explicitly.

export type Node = {
  id: string;
  type: "repo" | "language" | "topic" | "package" | "contributor" | "item" | "list";
  name?: string;
  fullName?: string;
  description?: string;
  language?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  archived?: boolean;
  isFork?: boolean;
  url?: string;
  homepage?: string;
  pushedAt?: string;
  // v2 (DESIGN-v2.md §3): stored at sync time; absent on pre-v2 nodes.
  rating?: number;
  freshness?: "fresh" | "stale" | "outdated";
  lastActivity?: string;
  // v2 list nodes (DESIGN-v2.md §1): the awesome README section the list sits in.
  section?: string;
};

export type EdgeType = "HAS_LANGUAGE" | "HAS_TOPIC" | "DEPENDS_ON" | "DEPENDS_ON_PKG" | "CONTRIBUTED_BY" | "LISTED_IN";

export type Edge = {
  source: string;
  target: string;
  type: EdgeType;
};

export type Subgraph = {
  nodes: Node[];
  edges: Edge[];
};

let NODES: Node[] = [];
let EDGES: Edge[] = [];
let byId = new Map<string, Node>();
let outEdges = new Map<string, Edge[]>();
let inEdges = new Map<string, Edge[]>();
export let meta: Record<string, unknown> = {};
let loaded = false;
let langMapCache: Map<string, string> | null = null;

// ---- sharded mode (DESIGN-sharding.md) ----
// The production Worker never loads the full graph (37 MB). It loads a
// small "skeleton" (non-item nodes + edges among them) at cold start from
// catalog.json, then merges per-section shards (item nodes + LISTED_IN
// edges) on demand. `catalogSections` holds the precomputed section counts
// from the catalog; when set, sectionsWithCounts() returns them instead of
// computing from (possibly partial) loaded edges.
let catalogSections: { name: string; listCount: number; itemCount: number }[] | null = null;
let skeletonLoaded = false;

/** True once the skeleton (or a full graph) has been loaded. */
export function isSkeletonLoaded(): boolean {
  return skeletonLoaded || loaded;
}

/**
 * Load the skeleton: all non-item nodes + edges whose endpoints are both
 * non-item nodes. Called at cold start from catalog.json. Returns false
 * when the shape is wrong (state untouched).
 */
export function loadSkeleton(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return false;
  const nodes: Node[] = [];
  for (const n of d.nodes as unknown[]) {
    if (typeof n !== "object" || n === null) return false;
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || typeof node.type !== "string") return false;
    if (node.type === "item") return false; // skeleton must not contain items
    nodes.push(node as unknown as Node);
  }
  const edges: Edge[] = [];
  for (const e of d.edges as unknown[]) {
    if (typeof e !== "object" || e === null) return false;
    const edge = e as Record<string, unknown>;
    if (typeof edge.source !== "string" || typeof edge.target !== "string" || typeof edge.type !== "string") return false;
    edges.push(edge as unknown as Edge);
  }
  // Replace (never merge): the skeleton is the cold-start base.
  NODES = nodes;
  EDGES = edges;
  byId = new Map(nodes.map((n) => [n.id, n]));
  outEdges = new Map();
  inEdges = new Map();
  for (const e of edges) {
    (outEdges.get(e.source) ?? outEdges.set(e.source, []).get(e.source)!).push(e);
    (inEdges.get(e.target) ?? inEdges.set(e.target, []).get(e.target)!).push(e);
  }
  langMapCache = null;
  skeletonLoaded = true;
  return true;
}

/**
 * Merge one section shard into the loaded graph: its item + list nodes and
 * its LISTED_IN edges. Nodes already present (a duplicated item, or a list
 * node already in the skeleton) are kept as-is; edges are deduped. Returns
 * false when the shape is wrong (state untouched).
 */
export function loadShard(raw: unknown): boolean {
  const parsed = parseShardJson(raw);
  if (!parsed) return false;
  for (const n of parsed.nodes) {
    if (!byId.has(n.id)) {
      byId.set(n.id, n);
      NODES.push(n);
    }
  }
  const seenEdge = new Set<string>();
  for (const arr of [...outEdges.values(), ...inEdges.values()]) {
    for (const e of arr) seenEdge.add(`${e.source}|${e.target}|${e.type}`);
  }
  for (const e of parsed.edges) {
    const key = `${e.source}|${e.target}|${e.type}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    EDGES.push(e);
    (outEdges.get(e.source) ?? outEdges.set(e.source, []).get(e.source)!).push(e);
    (inEdges.get(e.target) ?? inEdges.set(e.target, []).get(e.target)!).push(e);
  }
  langMapCache = null;
  return true;
}

/** Validate a shard file ({version, section, nodes, edges, index}). */
function parseShardJson(data: unknown): { nodes: Node[]; edges: Edge[] } | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return null;
  const nodes: Node[] = [];
  for (const n of d.nodes as unknown[]) {
    if (typeof n !== "object" || n === null) return null;
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || typeof node.type !== "string") return null;
    nodes.push(node as unknown as Node);
  }
  const edges: Edge[] = [];
  for (const e of d.edges as unknown[]) {
    if (typeof e !== "object" || e === null) return null;
    const edge = e as Record<string, unknown>;
    if (typeof edge.source !== "string" || typeof edge.target !== "string" || typeof edge.type !== "string") return null;
    edges.push(edge as unknown as Edge);
  }
  return { nodes, edges };
}

/** Set the catalog meta + precomputed sections (from catalog.json). */
export function setCatalogMetaSections(
  metaObj: Record<string, unknown>,
  sections: { name: string; listCount: number; itemCount: number }[],
): void {
  meta = metaObj;
  catalogSections = sections;
}

/** True when the catalog (sharded mode) has been loaded. */
export function isCatalogLoaded(): boolean {
  return catalogSections !== null;
}

/** Test-only: clear the skeleton, shards, catalog override, and graph. */
export function resetShardedForTesting(): void {
  catalogSections = null;
  skeletonLoaded = false;
  resetGraphForTesting();
}

/** True once a graph has been loaded (via loadGraphData / ensureData). */
export function isGraphLoaded(): boolean {
  return loaded;
}

/** Validate raw parsed JSON into nodes/edges/meta; null when the shape is wrong. */
function parseGraphJson(data: unknown): { nodes: Node[]; edges: Edge[]; meta: Record<string, unknown> } | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return null;
  const nodes: Node[] = [];
  for (const n of d.nodes as unknown[]) {
    if (typeof n !== "object" || n === null) return null;
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || typeof node.type !== "string") return null;
    nodes.push(node as unknown as Node);
  }
  const edges: Edge[] = [];
  for (const e of d.edges as unknown[]) {
    if (typeof e !== "object" || e === null) return null;
    const edge = e as Record<string, unknown>;
    if (typeof edge.source !== "string" || typeof edge.target !== "string" || typeof edge.type !== "string") return null;
    edges.push(edge as unknown as Edge);
  }
  const metaObj = typeof d.meta === "object" && d.meta !== null ? (d.meta as Record<string, unknown>) : {};
  return { nodes, edges, meta: metaObj };
}

/**
 * Load a graph into the module-level indexes. Returns false (leaving any
 * previously loaded graph untouched) when the data is invalid.
 */
export function loadGraphData(raw: unknown): boolean {
  const parsed = parseGraphJson(raw);
  if (!parsed) return false;
  const nextById = new Map<string, Node>();
  const nextOut = new Map<string, Edge[]>();
  const nextIn = new Map<string, Edge[]>();
  for (const n of parsed.nodes) nextById.set(n.id, n);
  for (const e of parsed.edges) {
    (nextOut.get(e.source) ?? nextOut.set(e.source, []).get(e.source)!).push(e);
    (nextIn.get(e.target) ?? nextIn.set(e.target, []).get(e.target)!).push(e);
  }
  NODES = parsed.nodes;
  EDGES = parsed.edges;
  byId = nextById;
  outEdges = nextOut;
  inEdges = nextIn;
  meta = parsed.meta;
  langMapCache = null;
  loaded = true;
  return true;
}

/** Test-only: clear the loaded graph (and the language cache). */
export function resetGraphForTesting(): void {
  NODES = [];
  EDGES = [];
  byId = new Map();
  outEdges = new Map();
  inEdges = new Map();
  meta = {};
  langMapCache = null;
  loaded = false;
  catalogSections = null;
  skeletonLoaded = false;
}

export function getNode(id: string): Node | undefined {
  return byId.get(id);
}

export function neighbors(id: string, max = 50): { node: Node; via: Edge }[] {
  const out: { node: Node; via: Edge }[] = [];
  for (const e of outEdges.get(id) ?? []) {
    const n = byId.get(e.target);
    if (n) out.push({ node: n, via: e });
    if (out.length >= max) break;
  }
  for (const e of inEdges.get(id) ?? []) {
    const n = byId.get(e.source);
    if (n) out.push({ node: n, via: e });
    if (out.length >= max) break;
  }
  return out;
}

export function allRepos(): Node[] {
  return NODES.filter((n) => n.type === "repo");
}

/** All awesome-list nodes (type "list", v2 graph only; empty on the current graph). */
export function allLists(): Node[] {
  return NODES.filter((n) => n.type === "list");
}

/** All item nodes (tools listed inside a list/repo). */
export function allItems(): Node[] {
  return NODES.filter((n) => n.type === "item");
}

/** Items listed in the given list (LISTED_IN edges: item -> list). */
export function itemsOfList(listId: string): Node[] {
  const ids = (inEdges.get(listId) ?? [])
    .filter((e) => e.type === "LISTED_IN")
    .map((e) => e.source);
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

/** The list (or, on the pre-v2 graph, the repo) an item is listed in, if any. */
export function listOfItem(itemId: string): Node | undefined {
  const ids = (outEdges.get(itemId) ?? [])
    .filter((e) => e.type === "LISTED_IN")
    .map((e) => e.target);
  const first = ids[0];
  return first ? byId.get(first) : undefined;
}

/**
 * Category counts for the filter bar (DESIGN-v2.md §6).
 * From list nodes' `section` field when lists exist. When the graph has no
 * list nodes yet (current graph), falls back to the top 12 topics by repo count.
 */
export function sectionsWithCounts(): { name: string; listCount: number; itemCount: number }[] {
  // Sharded mode: the catalog precomputed these from the FULL graph.
  // Computing from loaded data would undercount (only loaded shards).
  if (catalogSections) return catalogSections;
  const lists = allLists();
  if (lists.length === 0) {
    const counts = new Map<string, number>();
    for (const [id, edges] of inEdges) {
      if (!id.startsWith("topic:")) continue;
      const c = edges.filter((e) => e.type === "HAS_TOPIC").length;
      if (c > 0) counts.set(id, c);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([id, count]) => ({
        name: byId.get(id)?.name ?? id.replace(/^topic:/, ""),
        listCount: 0,
        itemCount: count,
      }));
  }
  const bySection = new Map<string, { listCount: number; itemCount: number }>();
  const sectionOfList = new Map<string, string>();
  for (const l of lists) {
    const s = l.section ?? "Other";
    sectionOfList.set(l.id, s);
    const entry = bySection.get(s) ?? { listCount: 0, itemCount: 0 };
    entry.listCount += 1;
    bySection.set(s, entry);
  }
  for (const e of EDGES) {
    if (e.type !== "LISTED_IN") continue;
    const s = sectionOfList.get(e.target);
    if (!s) continue;
    bySection.get(s)!.itemCount += 1;
  }
  return [...bySection.entries()]
    .map(([name, c]) => ({ name, listCount: c.listCount, itemCount: c.itemCount }))
    .sort((a, b) => b.itemCount - a.itemCount || b.listCount - a.listCount || a.name.localeCompare(b.name));
}

export function reposWithTopic(topic: string): Node[] {
  const tid = `topic:${topic.toLowerCase()}`;
  const ids = (inEdges.get(tid) ?? []).map((e) => e.source);
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

/** lowercase -> exact stored language name (e.g. "typescript" -> "TypeScript"). */
export function languageNames(): Map<string, string> {
  if (!langMapCache) {
    langMapCache = new Map();
    for (const n of NODES) {
      if (n.type === "language" && n.name) {
        langMapCache.set(n.name.toLowerCase(), n.name);
      }
    }
  }
  return langMapCache;
}

/** Repos that depend on the given repo/package id (incoming DEPENDS_ON / DEPENDS_ON_PKG). */
export function reposDependingOn(id: string): Node[] {
  const ids = (inEdges.get(id) ?? [])
    .filter((e) => e.type === "DEPENDS_ON" || e.type === "DEPENDS_ON_PKG")
    .map((e) => e.source);
  return ids.map((x) => byId.get(x)!).filter(Boolean);
}

/** Contributors of a repo (edges point user -> repo, so sources of in-edges). */
export function contributorsOf(id: string): Node[] {
  const ids = (inEdges.get(id) ?? [])
    .filter((e) => e.type === "CONTRIBUTED_BY")
    .map((e) => e.source);
  return ids.map((x) => byId.get(x)!).filter(Boolean);
}

export function reposByContributor(userId: string): Node[] {
  const ids = (inEdges.get(userId) ?? [])
    .filter((e) => e.type === "CONTRIBUTED_BY")
    .map((e) => e.source);
  return ids.map((x) => byId.get(x)!).filter(Boolean);
}

/** Item nodes whose name contains the token (case-insensitive), ranked best-first. */
export function findItemsByName(token: string): Node[] {
  const t = token.toLowerCase();
  const hits = NODES.filter(
    (n) => n.type === "item" && (n.name ?? "").toLowerCase().includes(t),
  );
  return hits.sort((a, b) => {
    const an = (a.name ?? "").toLowerCase();
    const bn = (b.name ?? "").toLowerCase();
    const rank = (s: string) => (s === t ? 0 : s.startsWith(t) ? 1 : 2);
    const d = rank(an) - rank(bn);
    return d !== 0 ? d : an.length - bn.length;
  });
}

/** Repos that list the given item (LISTED_IN edges: item -> repo). */
export function reposListingItem(itemId: string): Node[] {
  const ids = EDGES
    .filter((e) => e.type === "LISTED_IN" && e.source === itemId)
    .map((e) => e.target);
  return ids.map((x) => byId.get(x)!).filter(Boolean);
}

export function findNodeByName(name: string): Node | undefined {
  const n = name.toLowerCase().replace(/^@/, "").replace("_", "-");
  const exact = byId.get(n) ?? byId.get(`topic:${n}`) ?? byId.get(`pkg:${n}`) ?? byId.get(`user:${n}`);
  if (exact) return exact;
  for (const node of allRepos()) {
    if (node.id.toLowerCase() === n) return node;
  }
  return undefined;
}

export function reposWithLanguage(lang: string): Node[] {
  const lid = `lang:${lang}`;
  const ids = (inEdges.get(lid) ?? []).map((e) => e.source);
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

/** Build a bounded subgraph around the given repo ids (1-hop). */
export function subgraphAround(ids: string[], nodeCap = 200): Subgraph {
  const picked: Node[] = [];
  const seen = new Set<string>();
  const pendingEdges: Edge[] = [];

  for (const id of ids) {
    const n = byId.get(id);
    if (!n || seen.has(id)) continue;
    seen.add(id);
    picked.push(n);
    for (const e of outEdges.get(id) ?? []) {
      pendingEdges.push(e);
      if (!seen.has(e.target) && picked.length < nodeCap) {
        const t = byId.get(e.target);
        if (t) {
          seen.add(e.target);
          picked.push(t);
        }
      }
    }
    for (const e of inEdges.get(id) ?? []) {
      pendingEdges.push(e);
      if (!seen.has(e.source) && picked.length < nodeCap) {
        const s = byId.get(e.source);
        if (s) {
          seen.add(e.source);
          picked.push(s);
        }
      }
    }
  }

  // truncate nodes first; then keep only edges whose endpoints are in the FINAL node set
  const finalNodes = picked.slice(0, nodeCap);
  const finalIds = new Set(finalNodes.map((n) => n.id));
  const dedup = new Set<string>();
  const edges: Edge[] = [];
  for (const e of pendingEdges) {
    if (!finalIds.has(e.source) || !finalIds.has(e.target)) continue;
    const key = `${e.source}|${e.target}|${e.type}`;
    if (dedup.has(key)) continue;
    dedup.add(key);
    edges.push(e);
  }
  return { nodes: finalNodes, edges };
}

/** Bounded subgraph from a list of topic/language root ids. */
export function subgraphFromRoots(roots: string[], nodeCap = 200): Subgraph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const seenEdges = new Set<string>();
  for (const r of roots) {
    const root = byId.get(r);
    if (!root || seen.has(r)) continue;
    seen.add(r);
    nodes.push(root);
    for (const e of outEdges.get(r) ?? []) {
      const key = `${e.source}|${e.target}|${e.type}`;
      const hasTarget = seen.has(e.target);
      const hasSource = seen.has(e.source);
      if (hasTarget && hasSource && !seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push(e);
      }
      if (nodes.length < nodeCap && !hasTarget) {
        const t = byId.get(e.target);
        if (t) {
          seen.add(e.target);
          nodes.push(t);
        }
      }
    }
    for (const e of inEdges.get(r) ?? []) {
      const key = `${e.source}|${e.target}|${e.type}`;
      const hasTarget = seen.has(e.target);
      const hasSource = seen.has(e.source);
      if (hasTarget && hasSource && !seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push(e);
      }
      if (nodes.length < nodeCap && !hasSource) {
        const s = byId.get(e.source);
        if (s) {
          seen.add(e.source);
          nodes.push(s);
        }
      }
    }
  }
  return { nodes, edges };
}
