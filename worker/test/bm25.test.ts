// BM25 suite — ranking formula, tf recovery from TF-IDF weights,
// search over one index and across shards, ranker wiring in answerCards,
// and the HTTP ranker parameter. Run: npm test (… && tsx test/bm25.test.ts).
// Uses only node:assert + tsx.
//
// Hand-computed reference values (k1 = 1.2, b = 0.75):
//   bm25TermScore(tf, len, avgdl, idf) = idf * tf*(k1+1) / (tf + k1*(1-b+b*len/avgdl))
//   tf=1, len=avgdl, idf=1  -> 2.2 / 2.2 = 1.0
//   tf=2, len=avgdl, idf=1  -> 4.4 / 3.2 = 1.375
//   tf=10, len=avgdl, idf=1 -> 22 / 11.2 = 1.9642857
//   tf=1, len=avgdl/2, idf=1 -> 2.2 / 1.75 = 1.2571429 (short doc wins)
//   tf=1, len=2*avgdl, idf=1 -> 2.2 / 3.1 = 0.7096774 (long doc loses)

import assert from "node:assert/strict";
import {
  BM25_B,
  BM25_K1,
  bm25Search,
  bm25SearchSharded,
  bm25TermScore,
  isBm25Enabled,
  recoverTf,
} from "../src/bm25";
import {
  isTfidfEnabled,
  loadSearchIndex,
  loadShardIndex,
  parseSearchJson,
  resetSearchIndexForTesting,
  searchWithIndex,
  type TfIdfIndex,
} from "../src/tfidf";
import { answerCards } from "../src/retrieval";
import { loadGraphData, resetGraphForTesting } from "../src/graph";
import { ensureData, resetDataForTesting } from "../src/data";
import worker from "../src/index";

const DAY_MS = 86_400_000;
const RECENT = new Date(Date.now() - 10 * DAY_MS).toISOString();

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.log(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
    });
}

/** Approximate equality for hand-computed floats. */
function approx(actual: number, expected: number, tol = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${expected} (±${tol}), got ${actual}`,
  );
}

// ---- hand-built index for the search tests ----
// Three docs; the docLens/avgdl values are chosen for the MATH (short doc
// len 2, long doc len 8, avgdl 11/3) so the expected scores are clean
// hand-computable numbers. They are NOT the builder's lengths for these
// names (the builder counts name + description tokens); the
// builder-length correspondence is verified in scripts (build_shards.py).
const tinyBm25Index: TfIdfIndex = {
  version: 1,
  terms: {
    python: { idf: 1.0, postings: [["item:short", 1.0], ["item:long", 1.0], ["item:other", 1.0]] },
    testing: { idf: 1.5, postings: [["item:long", 3.9142], ["item:short", 1.5]] },
  },
  norms: { "item:short": 1.0, "item:long": 1.0, "item:other": 1.0 },
  docLens: { "item:short": 2, "item:long": 8, "item:other": 1 },
  avgdl: 11 / 3,
};
// Same index without BM25 data (old shard / legacy search.json shape).
const tinyNoBm25Index: TfIdfIndex = {
  version: 1,
  terms: tinyBm25Index.terms,
  norms: tinyBm25Index.norms,
};

const tinyGraph = {
  meta: { nodeCount: 4, itemCount: 3, listCount: 1 },
  nodes: [
    { id: "item:short", type: "item", name: "short", description: "python testing", url: "https://example.com/short", stars: 100, lastActivity: RECENT, rating: 4, freshness: "fresh" },
    { id: "item:long", type: "item", name: "long", description: "python testing testing testing testing testing extra words here now", url: "https://example.com/long", stars: 100, lastActivity: RECENT, rating: 4, freshness: "fresh" },
    { id: "item:other", type: "item", name: "other", description: "python", url: "https://example.com/other", stars: 100, lastActivity: RECENT, rating: 4, freshness: "fresh" },
    { id: "list:awesome-python", type: "list", name: "awesome-python", section: "Programming Languages", fullName: "vinta/awesome-python", stars: 1000 },
  ],
  edges: [
    { source: "item:short", target: "list:awesome-python", type: "LISTED_IN" },
    { source: "item:long", target: "list:awesome-python", type: "LISTED_IN" },
    { source: "item:other", target: "list:awesome-python", type: "LISTED_IN" },
  ],
};

console.log("\n[1] BM25 formula (hand-computed)");
await check("constants are the standard defaults k1=1.2, b=0.75", () => {
  assert.equal(BM25_K1, 1.2);
  assert.equal(BM25_B, 0.75);
});
await check("tf=1 at average length, idf=1 -> exactly 1.0", () => {
  approx(bm25TermScore(1, 10, 10, 1), 1.0);
});
await check("term saturation: score grows sublinearly with tf", () => {
  const s1 = bm25TermScore(1, 10, 10, 1);
  const s2 = bm25TermScore(2, 10, 10, 1);
  const s10 = bm25TermScore(10, 10, 10, 1);
  approx(s1, 1.0);
  approx(s2, 1.375);
  approx(s10, 1.9642857, 1e-6);
  // Doubling tf less than doubles the score; 10x tf is under 2x the tf=1 score.
  assert.ok(s2 < 2 * s1, `s2=${s2} should be < ${2 * s1}`);
  assert.ok(s10 < 2 * s1, `s10=${s10} should be < ${2 * s1}`);
  assert.ok(s10 < 2 * s2, `s10=${s10} should be < ${2 * s2}`);
});
await check("length normalisation: short doc outranks long doc, same tf", () => {
  const short = bm25TermScore(1, 5, 10, 1);
  const avg = bm25TermScore(1, 10, 10, 1);
  const long = bm25TermScore(1, 20, 10, 1);
  approx(short, 1.2571429, 1e-6);
  approx(avg, 1.0);
  approx(long, 0.7096774, 1e-6);
  assert.ok(short > avg && avg > long, `short=${short} avg=${avg} long=${long}`);
});
await check("idf scales the score linearly (rare term wins)", () => {
  const rare = bm25TermScore(2, 10, 10, 2);
  const common = bm25TermScore(2, 10, 10, 1);
  approx(rare, 2 * common, 1e-9);
});
await check("edge cases return 0, never NaN/negative", () => {
  assert.equal(bm25TermScore(0, 10, 10, 1), 0);
  assert.equal(bm25TermScore(1, 10, 0, 1), 0);
  assert.equal(bm25TermScore(1, -1, 10, 1), 0);
  assert.ok(Number.isFinite(bm25TermScore(1, 0, 10, 1)) && bm25TermScore(1, 0, 10, 1) > 0);
});

console.log("\n[2] tf recovery from TF-IDF weights");
await check("weight == idf -> tf 1 (the term occurs once)", () => {
  approx(recoverTf(1.0, 1.0), 1.0, 1e-9);
  approx(recoverTf(2.5, 2.5), 1.0, 1e-9);
});
await check("weight (1+ln 2)*idf -> tf 2; (1+ln 5)*idf -> tf 5", () => {
  approx(recoverTf(1.6931 * 1.5, 1.5), 2.0, 1e-3);
  approx(recoverTf(2.6094 * 1.5, 1.5), 5.0, 1e-3);
});
await check("non-positive idf/weight guard -> 1, never NaN", () => {
  assert.equal(recoverTf(0, 1.0), 1);
  assert.equal(recoverTf(1.0, 0), 1);
  assert.equal(recoverTf(1.0, -1), 1);
  assert.equal(recoverTf(-2, 1.0), 1);
});

console.log("\n[3] bm25Search on the hand-built index");
await check("short doc (tf=1) outranks long doc (tf=5) — length norm + saturation", () => {
  const hits = bm25Search(tinyBm25Index, "python testing");
  assert.deepEqual(hits.map((h) => h.id), ["item:short", "item:long", "item:other"]);
  // Hand-computed: short 3.0712, long 2.9457, other 1.4235.
  approx(hits[0]?.score ?? 0, 3.0712, 0.01);
  approx(hits[1]?.score ?? 0, 2.9457, 0.01);
  approx(hits[2]?.score ?? 0, 1.4235, 0.01);
});
await check("BM25 disagrees with TF-IDF here (TF-IDF ranks the long doc first)", () => {
  const tfidf = searchWithIndex(tinyBm25Index, "python testing");
  assert.deepEqual(tfidf.map((h) => h.id), ["item:long", "item:short", "item:other"]);
  // TF-IDF: long (1.0+3.9142)/1 = 4.9142, short (1.0+1.5)/1 = 2.5, other 1.0.
  approx(tfidf[0]?.score ?? 0, 4.9142, 0.01);
  assert.notDeepEqual(
    bm25Search(tinyBm25Index, "python testing").map((h) => h.id),
    tfidf.map((h) => h.id),
  );
});
await check("unknown terms and null index -> []", () => {
  assert.deepEqual(bm25Search(tinyBm25Index, "zzzzqq"), []);
  assert.deepEqual(bm25Search(null, "python"), []);
  assert.deepEqual(bm25Search(tinyBm25Index, ""), []);
});
await check("limit is honoured", () => {
  const hits = bm25Search(tinyBm25Index, "python testing", 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.id, "item:short");
});

console.log("\n[4] BM25 unavailable without docLens/avgdl");
await check("bm25Search on an index without BM25 data -> [] (TF-IDF still works)", () => {
  assert.deepEqual(bm25Search(tinyNoBm25Index, "python testing"), []);
  const tfidf = searchWithIndex(tinyNoBm25Index, "python testing");
  assert.equal(tfidf[0]?.id, "item:long");
});
await check("parseSearchJson keeps BM25 data when present, drops it when malformed", () => {
  const withBm25 = parseSearchJson(tinyBm25Index);
  assert.ok(withBm25);
  assert.deepEqual(withBm25.docLens, tinyBm25Index.docLens);
  assert.equal(withBm25.avgdl, tinyBm25Index.avgdl);
  const withoutBm25 = parseSearchJson(tinyNoBm25Index);
  assert.ok(withoutBm25);
  assert.equal(withoutBm25.docLens, undefined);
  assert.equal(withoutBm25.avgdl, undefined);
  // Malformed docLens/avgdl must NOT break the TF-IDF index.
  const malformed = parseSearchJson({ ...tinyBm25Index, docLens: { "item:short": "x" }, avgdl: -1 });
  assert.ok(malformed);
  assert.equal(malformed.docLens, undefined);
  assert.equal(malformed.avgdl, undefined);
  assert.equal(malformed.terms["python"].postings.length, 3);
});
await check("isBm25Enabled follows the loaded index", () => {
  resetSearchIndexForTesting();
  assert.equal(isBm25Enabled(), false);
  assert.equal(loadSearchIndex(tinyNoBm25Index), true);
  assert.equal(isBm25Enabled(), false);
  assert.equal(isTfidfEnabled(), true);
  resetSearchIndexForTesting();
  assert.equal(loadSearchIndex(tinyBm25Index), true);
  assert.equal(isBm25Enabled(), true);
  resetSearchIndexForTesting();
});

console.log("\n[5] sharded BM25 aggregation");
await check("bm25SearchSharded merges shard indexes, max score wins", () => {
  resetSearchIndexForTesting();
  const shardA = {
    version: 1,
    terms: {
      python: { idf: 1.0, postings: [["item:short", 1.0]] },
      testing: { idf: 1.5, postings: [["item:short", 1.5]] },
    },
    norms: { "item:short": 1.0 },
    docLens: { "item:short": 2 },
    avgdl: 11 / 3,
  };
  const shardB = {
    version: 1,
    terms: {
      python: { idf: 1.0, postings: [["item:long", 1.0], ["item:other", 1.0]] },
      testing: { idf: 1.5, postings: [["item:long", 3.9142]] },
    },
    norms: { "item:long": 1.0, "item:other": 1.0 },
    docLens: { "item:long": 8, "item:other": 1 },
    avgdl: 11 / 3,
  };
  assert.equal(loadShardIndex("a", shardA), true);
  assert.equal(loadShardIndex("b", shardB), true);
  assert.equal(isBm25Enabled(), true);
  const hits = bm25SearchSharded("python testing");
  assert.deepEqual(hits.map((h) => h.id), ["item:short", "item:long", "item:other"]);
  // A doc present in two shards keeps its max score.
  const shardA2 = {
    version: 1,
    terms: { python: { idf: 1.0, postings: [["item:short", 1.0]] } },
    norms: { "item:short": 1.0 },
    docLens: { "item:short": 2 },
    avgdl: 11 / 3,
  };
  resetSearchIndexForTesting();
  assert.equal(loadShardIndex("a", shardA2), true);
  assert.equal(loadShardIndex("b", shardB), true);
  const hits2 = bm25SearchSharded("python");
  assert.equal(hits2[0]?.id, "item:other");
  resetSearchIndexForTesting();
});
await check("sharded search with no BM25 data -> []", () => {
  resetSearchIndexForTesting();
  assert.equal(loadShardIndex("a", tinyNoBm25Index), true);
  assert.deepEqual(bm25SearchSharded("python testing"), []);
  resetSearchIndexForTesting();
});

console.log("\n[6] answerCards ranker wiring");
await check("ranker=bm25 orders by BM25, ranker=tfidf by TF-IDF (same candidates)", () => {
  resetGraphForTesting();
  assert.ok(loadGraphData(tinyGraph));
  const bm25 = answerCards("python testing", 10, tinyBm25Index, "bm25");
  const tfidf = answerCards("python testing", 10, tinyBm25Index, "tfidf");
  assert.deepEqual(bm25.cards.map((c) => c.id), ["item:short", "item:long", "item:other"]);
  assert.deepEqual(tfidf.cards.map((c) => c.id), ["item:long", "item:short", "item:other"]);
  assert.equal(bm25.cards[0]?.name, "short");
  assert.equal(tfidf.cards[0]?.name, "long");
  resetGraphForTesting();
});
await check("ranker=bm25 without BM25 data falls back to TF-IDF order", () => {
  resetGraphForTesting();
  assert.ok(loadGraphData(tinyGraph));
  const bm25 = answerCards("python testing", 10, tinyNoBm25Index, "bm25");
  const tfidf = answerCards("python testing", 10, tinyNoBm25Index, "tfidf");
  assert.deepEqual(bm25.cards.map((c) => c.id), tfidf.cards.map((c) => c.id));
  assert.deepEqual(bm25.cards.map((c) => c.id), ["item:long", "item:short", "item:other"]);
  resetGraphForTesting();
});
await check("ranker defaults to bm25 (the benchmark winner) when omitted", () => {
  resetGraphForTesting();
  assert.ok(loadGraphData(tinyGraph));
  const def = answerCards("python testing", 10, tinyBm25Index);
  const bm25 = answerCards("python testing", 10, tinyBm25Index, "bm25");
  assert.deepEqual(def.cards.map((c) => c.id), bm25.cards.map((c) => c.id));
  assert.deepEqual(def.cards.map((c) => c.id), ["item:short", "item:long", "item:other"]);
  resetGraphForTesting();
});

console.log("\n[7] HTTP ranker parameter");
type MockBucket = {
  calls: string[];
  get(key: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> } | null>;
};
function mockBucket(files: Record<string, unknown>): MockBucket {
  const calls: string[] = [];
  return {
    calls,
    async get(key: string) {
      calls.push(key);
      if (!(key in files)) return null;
      const value = files[key];
      return { json: async () => value, text: async () => JSON.stringify(value) };
    },
  };
}
const post = (path: string, body: unknown, env: unknown = {}, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env as never,
  );
// Tiny sharded bucket whose shard index carries BM25 data.
const httpCatalog = {
  version: 1,
  meta: { repoCount: 1, nodeCount: 4, edgeCount: 3, listCount: 1, itemCount: 2, generatedAt: RECENT },
  sections: [{ name: "Programming Languages", listCount: 1, itemCount: 2 }],
  trending: [],
  topBySection: {},
  skeleton: {
    nodes: [
      { id: "repo:awesome-python", type: "repo", fullName: "vinta/awesome-python", description: "Awesome Python list", language: "Python", stars: 1000, forks: 10, url: "https://github.com/vinta/awesome-python", pushedAt: RECENT },
      { id: "list:awesome-python", type: "list", name: "awesome-python", section: "Programming Languages", fullName: "vinta/awesome-python", stars: 1000 },
    ],
    edges: [],
  },
};
const httpTermmap = {
  version: 1,
  sections: ["Programming Languages"],
  terms: { pytest: [0], python: [0], testing: [0] },
};
const httpShard = {
  version: 1,
  section: "Programming Languages",
  nodes: [
    { id: "item:pytest", type: "item", name: "pytest", description: "Python testing framework", url: "https://github.com/pytest-dev/pytest", stars: 5000, lastActivity: RECENT, rating: 5, freshness: "fresh" },
    { id: "item:nose2", type: "item", name: "nose2", description: "Python testing framework", url: "https://github.com/nose-devs/nose2", stars: 100, lastActivity: RECENT, rating: 2, freshness: "stale" },
    { id: "list:awesome-python", type: "list", name: "awesome-python", section: "Programming Languages", fullName: "vinta/awesome-python", stars: 1000 },
  ],
  edges: [
    { source: "item:pytest", target: "list:awesome-python", type: "LISTED_IN" },
    { source: "item:nose2", target: "list:awesome-python", type: "LISTED_IN" },
  ],
  index: {
    version: 1,
    terms: {
      pytest: { idf: 1.0, postings: [["item:pytest", 1.0]] },
      python: { idf: 0.5, postings: [["item:pytest", 0.5], ["item:nose2", 0.5]] },
      testing: { idf: 1.0, postings: [["item:pytest", 1.0], ["item:nose2", 1.0]] },
    },
    norms: { "item:pytest": 1.0, "item:nose2": 1.0 },
    docLens: { "item:pytest": 4, "item:nose2": 4 },
    avgdl: 10 / 3,
  },
};
function httpBucket(): MockBucket {
  return mockBucket({
    "catalog.json": httpCatalog,
    "termmap.json": httpTermmap,
    "shards/programming-languages.json": httpShard,
  });
}
await check("POST /api/answer with ranker=bm25 -> 200 with cards", async () => {
  resetDataForTesting();
  const res = await post("/api/answer", { question: "pytest", ranker: "bm25" }, { DATA: httpBucket() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cards: { id: string }[] };
  assert.ok(body.cards.length > 0, "expected cards");
  assert.equal(body.cards[0]?.id, "item:pytest");
});
await check("POST /api/answer with an invalid ranker -> 400", async () => {
  resetDataForTesting();
  const res = await post("/api/answer", { question: "pytest", ranker: "bogus" }, { DATA: httpBucket() });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("ranker"), body.error);
});
await check("POST /api/answer without ranker -> 200 (BM25 default)", async () => {
  resetDataForTesting();
  const res = await post("/api/answer", { question: "pytest" }, { DATA: httpBucket() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cards: { id: string }[] };
  assert.ok(body.cards.length > 0);
});
await check("env DEFAULT_RANKER=bm25 applies when the body has no ranker", async () => {
  resetDataForTesting();
  const res = await post(
    "/api/answer",
    { question: "pytest" },
    { DATA: httpBucket(), DEFAULT_RANKER: "bm25" },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cards: { id: string }[] };
  assert.ok(body.cards.length > 0);
  assert.equal(body.cards[0]?.id, "item:pytest");
});

// Leave the module in a sane state for anything that runs after this file.
resetSearchIndexForTesting();
resetGraphForTesting();

console.log(`\nBM25: ${passed} CHECKS PASSED, ${failed} FAILED\n`);
if (failed > 0) process.exitCode = 1;
