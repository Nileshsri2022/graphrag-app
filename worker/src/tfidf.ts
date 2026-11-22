// TF-IDF semantic search (DESIGN-v2.md §4) — free, build-time, no embeddings.
// The index is built at sync time (data agent) and shipped as worker/data/search.json:
//   {"version": 1, "terms": {"<term>": {"idf": <float>, "postings": [["<nodeId>", <weight>], ...]}}, "norms": {"<nodeId>": <float>}}
// The file is loaded with a guarded dynamic import: if it is missing or
// invalid, TF-IDF is disabled and search degrades to template matching.
// The worker NEVER crashes on a missing/bad search.json.

import type { Node } from "./graph";

export type TfIdfIndex = {
  terms: Record<string, { idf: number; postings: [string, number][] }>;
  norms: Record<string, number>;
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
  return { terms, norms };
}

// ---- loader (guarded: missing/invalid file -> TF-IDF disabled, never a crash) ----
let loadedIndex: TfIdfIndex | null = null;
try {
  // Dynamic import so a missing file rejects (catchable) instead of failing
  // module load the way a static import would. Bundled by wrangler when present.
  const mod = await import("../data/search.json");
  loadedIndex = parseSearchJson(mod.default ?? mod);
} catch {
  loadedIndex = null;
}

/** True when a usable TF-IDF index was loaded from search.json. */
export function isTfidfEnabled(): boolean {
  return loadedIndex !== null;
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
  const hay = `${node.name ?? ""} ${node.description ?? ""}`.toLowerCase();
  const hit = terms.find((t) => t.length >= 2 && hay.includes(t));
  if (hit) parts.push(`Matches '${hit}'`);
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
