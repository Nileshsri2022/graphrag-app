// BM25 lexical ranking (Robertson & Zaragoza) — an alternative to TF-IDF
// for the same inverted index. Same data, better ranking: TF-IDF grows
// unboundedly with term frequency and normalises by an L2 weight norm;
// BM25 saturates term frequency (a 10th occurrence adds almost nothing)
// and normalises by raw document length against the global average, so a
// short, focused doc outranks a long, rambling one with the same term count.
//
// The index stores NO raw term frequencies — only TF-IDF weights
// w = (1 + ln(tf)) * idf. tf is recovered exactly from that:
//   tf = exp(w / idf - 1)
// (weights and idf are rounded to 4 decimals at build time, so the
// recovered tf is approximate to ~1e-4 — negligible for ranking).
// Document frequency is NOT needed separately: the stored idf
// (ln(1 + N/df), global) is reused directly. Document length and the
// global average length come from the index's optional docLens/avgdl,
// written by scripts/build_shards.py into each shard's index. Indexes
// without them (older shards, the legacy global search.json) cannot do
// BM25 — bm25Search returns [] and callers fall back to TF-IDF.
//
// Limitation (honest): shard postings are capped at 20 docs per term per
// section, ranked by TF-IDF weight at build time. BM25 can only re-rank
// the docs TF-IDF already selected for the postings — a doc that BM25
// would love but TF-IDF ranked 21st never reaches the scorer. Raising
// the cap would grow the shards; this PR deliberately does NOT change it.
//
// Parameters are the standard defaults (tunable constants, not magic
// numbers buried in the formula): k1 = 1.2 (saturation), b = 0.75
// (length normalisation strength).

import { loadedIndexesForSearch, queryTerms, type TfIdfIndex } from "./tfidf";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export type Bm25Hit = { id: string; score: number };

/**
 * One term's BM25 contribution. Pure, so tests can verify it against
 * hand-computed values. tf = occurrences of the term in the doc,
 * docLen = the doc's token count, avgdl = the global average doc
 * length, idf = the term's stored global idf.
 */
export function bm25TermScore(
  tf: number,
  docLen: number,
  avgdl: number,
  idf: number,
  k1: number = BM25_K1,
  b: number = BM25_B,
): number {
  if (tf <= 0 || avgdl <= 0 || docLen < 0) return 0;
  const lenNorm = 1 - b + (b * docLen) / avgdl;
  return bm25TermScoreWithK1LenNorm(tf, k1 * lenNorm, idf, k1);
}

/**
 * BM25 term contribution with a precomputed k1*lenNorm
 * (lenNorm = 1 - b + b*docLen/avgdl). Same arithmetic as bm25TermScore,
 * so the result is bit-identical — the caller just hoists the per-doc
 * k1*lenNorm (which depends only on the doc, not the term) out of the
 * per-term loop. CPU (2026-11-23): lenNorm was recomputed for every
 * (term, doc) pair, including its division.
 */
export function bm25TermScoreWithK1LenNorm(
  tf: number,
  k1LenNorm: number,
  idf: number,
  k1: number = BM25_K1,
): number {
  if (tf <= 0) return 0;
  return (idf * (tf * (k1 + 1))) / (tf + k1LenNorm);
}

/**
 * Recover a posting's raw term frequency from its stored TF-IDF weight.
 * The builder stores w = (1 + ln(tf)) * idf, so tf = exp(w/idf - 1).
 * Guards: a non-positive idf or weight cannot come from a real posting,
 * so return 1 (the term is present, at least once).
 */
export function recoverTf(weight: number, idf: number): number {
  if (!(idf > 0) || !(weight > 0)) return 1;
  const tf = Math.exp(weight / idf - 1);
  return Number.isFinite(tf) && tf > 0 ? tf : 1;
}

/** True when this index carries the data BM25 needs (docLens + avgdl). */
export function indexHasBm25Data(index: TfIdfIndex | null): boolean {
  return (
    index !== null &&
    index.docLens !== undefined &&
    index.avgdl !== undefined &&
    index.avgdl > 0
  );
}

/**
 * Pure BM25 search over one index. Returns [] when the index is null or
 * lacks BM25 data (never throws). Same query terms (with synonym
 * expansion) as TF-IDF, so the two rankers are compared on identical
 * inputs. A doc missing from docLens is scored at the average length
 * (no length adjustment) rather than dropped.
 *
 * CPU (2026-11-23): the per-doc length normalisation (lenNorm, and
 * k1*lenNorm) is hoisted out of the per-term loop — it depends only on
 * the doc, not the term — and the query terms are computed once by the
 * caller, not once per shard. The arithmetic is unchanged, so scores
 * (and therefore ranking) are bit-identical to the unoptimised form.
 */
export function bm25Search(
  index: TfIdfIndex | null,
  query: string,
  limit = 10,
): Bm25Hit[] {
  if (!indexHasBm25Data(index) || !index) return [];
  const terms = [...new Set(queryTerms(query))];
  return bm25SearchTerms(index, terms, limit);
}

/**
 * BM25 search over one index with precomputed (deduped) query terms.
 * Internal: bm25Search / bm25SearchSharded compute the terms once and
 * reuse them across shards, instead of re-tokenising per shard.
 */
export function bm25SearchTerms(
  index: TfIdfIndex | null,
  terms: string[],
  limit = 10,
): Bm25Hit[] {
  if (!indexHasBm25Data(index) || !index) return [];
  if (terms.length === 0) return [];
  const avgdl = index.avgdl as number;
  const docLens = index.docLens as Record<string, number>;
  const scores = new Map<string, number>();
  // Per-doc length normalisation, computed once per doc per query and
  // reused across every term that matches the doc. lenNorm (and
  // k1*lenNorm) depend only on the doc's length, not the term.
  const k1LenNormByDoc = new Map<string, number>();
  for (const t of terms) {
    const entry = index.terms[t];
    if (!entry) continue;
    const idf = entry.idf;
    for (const [id, w] of entry.postings) {
      let k1LenNorm = k1LenNormByDoc.get(id);
      if (k1LenNorm === undefined) {
        const docLen = docLens[id] ?? avgdl;
        // A negative length is corrupt data: the old code scored such a
        // term as 0, so keep it at 0 here too (and remember it).
        if (docLen < 0) {
          k1LenNormByDoc.set(id, Number.NaN);
          continue;
        }
        const lenNorm = 1 - BM25_B + (BM25_B * docLen) / avgdl;
        k1LenNorm = BM25_K1 * lenNorm;
        k1LenNormByDoc.set(id, k1LenNorm);
      }
      if (Number.isNaN(k1LenNorm)) continue;
      const tf = recoverTf(w, idf);
      const s = bm25TermScoreWithK1LenNorm(tf, k1LenNorm, idf);
      if (s > 0) scores.set(id, (scores.get(id) ?? 0) + s);
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/**
 * Search across every loaded index (shard indexes when sharded, else the
 * global index), merged by id with the max score winning — the same
 * aggregation tfidfSearchSharded uses, so BM25 and TF-IDF are compared
 * on the same footing. Returns [] when no loaded index has BM25 data.
 * The query terms are computed once here and reused for every index
 * (bm25Search used to re-tokenise per shard).
 */
export function bm25SearchSharded(query: string, limit = 10): Bm25Hit[] {
  const indexes = loadedIndexesForSearch();
  if (indexes.length === 0) return [];
  const terms = [...new Set(queryTerms(query))];
  if (terms.length === 0) return [];
  const best = new Map<string, number>();
  for (const idx of indexes) {
    for (const hit of bm25SearchTerms(idx, terms, limit)) {
      const prev = best.get(hit.id);
      if (prev === undefined || hit.score > prev) best.set(hit.id, hit.score);
    }
  }
  return [...best.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/** True when at least one loaded index carries BM25 data. */
export function isBm25Enabled(): boolean {
  return loadedIndexesForSearch().some((idx) => indexHasBm25Data(idx));
}
