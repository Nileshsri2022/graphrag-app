// Sharded-data suite (DESIGN-sharding.md) — catalog + term-map cold start,
// per-section lazy shard loading, search across shards, catalog trending.
// Run: npm test (smoke + v2 + mcp + shards). Uses only node:assert + tsx.

import assert from "node:assert/strict";
import {
  catalogSections,
  catalogTrending,
  dataStatus,
  ensureData,
  ensureSections,
  ensureSectionsForNode,
  ensureSectionsForQuery,
  getCatalog,
  getTermmap,
  isSharded,
  loadedShards,
  resetDataForTesting,
  sectionsForQuery,
  slugifySection,
} from "../src/data";
import {
  allItems,
  getNode,
  isCatalogLoaded,
  isGraphLoaded,
  loadGraphData,
  meta,
  sectionsWithCounts,
  subgraphFromRoots,
} from "../src/graph";
import { buildWhyText, isTfidfEnabled, tfidfSearch, tfidfSearchSharded } from "../src/tfidf";
import { answerCards, trending } from "../src/retrieval";
import { handleMcp } from "../src/mcp";
import worker from "../src/index";
import { readFileSync } from "node:fs";

const DAY_MS = 86_400_000;
const RECENT = new Date(Date.now() - 10 * DAY_MS).toISOString();
const OLD = new Date(Date.now() - 900 * DAY_MS).toISOString();

// ---- tiny sharded fixtures (same shapes scripts/build_shards.py emits) ----
const tinyCatalog = {
  version: 1,
  meta: { repoCount: 1, nodeCount: 4, edgeCount: 3, listCount: 1, itemCount: 2, generatedAt: RECENT },
  sections: [{ name: "Programming Languages", listCount: 1, itemCount: 2 }],
  trending: [
    {
      rank: 1, id: "item:pytest", type: "item", name: "pytest",
      url: "https://github.com/pytest-dev/pytest",
      description: "Python testing framework", stars: 5000,
      lastActivity: RECENT, rating: 5, freshness: "fresh", listName: "awesome-python",
    },
  ],
  topBySection: {
    "Programming Languages": [
      {
        rank: 1, id: "item:pytest", type: "item", name: "pytest",
        url: "https://github.com/pytest-dev/pytest",
        description: "Python testing framework", stars: 5000,
        lastActivity: RECENT, rating: 5, freshness: "fresh", listName: "awesome-python",
      },
    ],
  },
  skeleton: {
    nodes: [
      { id: "repo:awesome-python", type: "repo", fullName: "vinta/awesome-python", description: "Awesome Python list", language: "Python", stars: 1000, forks: 10, url: "https://github.com/vinta/awesome-python", pushedAt: RECENT },
      { id: "list:awesome-python", type: "list", name: "awesome-python", section: "Programming Languages", fullName: "vinta/awesome-python", stars: 1000 },
    ],
    edges: [],
  },
};
const tinyTermmap = {
  version: 1,
  sections: ["Programming Languages"],
  terms: { pytest: [0], python: [0], testing: [0], nose2: [0] },
};
const tinyShard = {
  version: 1,
  section: "Programming Languages",
  nodes: [
    { id: "item:pytest", type: "item", name: "pytest", description: "Python testing framework", url: "https://github.com/pytest-dev/pytest", stars: 5000, lastActivity: RECENT, rating: 5, freshness: "fresh" },
    { id: "item:nose2", type: "item", name: "nose2", description: "Python testing framework", url: "https://github.com/nose-devs/nose2", stars: 100, lastActivity: OLD, rating: 2, freshness: "stale" },
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
      testing: { idf: 1.0, postings: [["item:pytest", 1.0], ["item:nose2", 0.8]] },
    },
    norms: { "item:pytest": 1.0, "item:nose2": 1.0 },
  },
};

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
function shardedBucket(extra: Record<string, unknown> = {}): MockBucket {
  return mockBucket({
    "catalog.json": tinyCatalog,
    "termmap.json": tinyTermmap,
    "shards/programming-languages.json": tinyShard,
    ...extra,
  });
}

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

console.log("\n[1] slugifySection matches the Python builder");
await check("'Programming Languages' -> 'programming-languages'", () => {
  assert.equal(slugifySection("Programming Languages"), "programming-languages");
});
await check("'Front-End Development' -> 'front-end-development'", () => {
  assert.equal(slugifySection("Front-End Development"), "front-end-development");
});
await check("'Health and Social Science' -> 'health-and-social-science'", () => {
  assert.equal(slugifySection("Health and Social Science"), "health-and-social-science");
});
await check("empty/odd names fall back to 'other'", () => {
  assert.equal(slugifySection(""), "other");
  assert.equal(slugifySection("!!!"), "other");
});

console.log("\n[2] cold start: catalog + term-map only, no items yet");
await check("ensureData loads catalog + termmap; meta + skeleton present; items absent", async () => {
  resetDataForTesting();
  const bucket = shardedBucket();
  const s = await ensureData({ DATA: bucket });
  assert.deepEqual(s, { graph: true, search: false, sharded: true, shards: [] });
  assert.equal(isSharded(), true);
  assert.equal(isCatalogLoaded(), true);
  assert.equal(meta.nodeCount, 4);
  assert.equal(getCatalog()?.sections[0]?.name, "Programming Languages");
  assert.equal(getTermmap()?.terms["pytest"]?.[0], 0);
  // skeleton nodes present, items absent until a shard loads
  assert.equal(getNode("repo:awesome-python")?.fullName, "vinta/awesome-python");
  assert.equal(getNode("list:awesome-python")?.section, "Programming Languages");
  assert.equal(getNode("item:pytest"), undefined);
  assert.equal(allItems().length, 0);
  assert.equal(isTfidfEnabled(), false);
  // cold start fetched exactly the two small files
  assert.deepEqual(bucket.calls, ["catalog.json", "termmap.json"]);
});
await check("sectionsWithCounts + categories come from the catalog", async () => {
  resetDataForTesting();
  await ensureData({ DATA: shardedBucket() });
  assert.deepEqual(sectionsWithCounts(), [{ name: "Programming Languages", listCount: 1, itemCount: 2 }]);
  assert.deepEqual(catalogSections(), [{ name: "Programming Languages", listCount: 1, itemCount: 2 }]);
});
await check("trending comes from the catalog with no shard fetch", async () => {
  resetDataForTesting();
  const bucket = shardedBucket();
  await ensureData({ DATA: bucket });
  const items = catalogTrending(10);
  assert.ok(items && items.length === 1);
  assert.equal(items[0].name, "pytest");
  assert.equal(items[0].rating, 5);
  assert.ok(typeof items[0].why === "string" && items[0].why.length > 0);
  assert.deepEqual(bucket.calls, ["catalog.json", "termmap.json"]);
});
await check("catalogTrending with a section category uses topBySection", async () => {
  resetDataForTesting();
  await ensureData({ DATA: shardedBucket() });
  const items = catalogTrending(10, "Programming Languages");
  assert.ok(items && items.length === 1 && items[0].name === "pytest");
  assert.equal(catalogTrending(10, "no-such-section"), null);
});

console.log("\n[3] routing: term-map -> sections (top 3)");
await check("sectionsForQuery routes 'best python testing tool' to Programming Languages", async () => {
  resetDataForTesting();
  await ensureData({ DATA: shardedBucket() });
  assert.deepEqual(sectionsForQuery("best python testing tool"), ["Programming Languages"]);
});
await check("unknown term routes nowhere (no shard fetch)", async () => {
  resetDataForTesting();
  await ensureData({ DATA: shardedBucket() });
  assert.deepEqual(sectionsForQuery("zzzzqqq unknownterm"), []);
});

console.log("\n[4] ensureSections: fetch once, cache, merge, TF-IDF aggregate");
await check("loads the shard; items + TF-IDF appear; second call issues no R2 GET", async () => {
  resetDataForTesting();
  const bucket = shardedBucket();
  await ensureData({ DATA: bucket });
  const loaded = await ensureSections({ DATA: bucket }, ["Programming Languages"]);
  assert.deepEqual(loaded, ["programming-languages"]);
  assert.deepEqual(loadedShards(), ["programming-languages"]);
  assert.equal(getNode("item:pytest")?.name, "pytest");
  assert.equal(allItems().length, 2);
  assert.equal(isTfidfEnabled(), true);
  assert.equal(tfidfSearchSharded("pytest")[0]?.id, "item:pytest");
  // cached: no new R2 GET on repeat
  const before = bucket.calls.length;
  const loaded2 = await ensureSections({ DATA: bucket }, ["Programming Languages"]);
  assert.deepEqual(loaded2, []);
  assert.equal(bucket.calls.length, before);
});
await check("answerCards on loaded shards ranks pytest first (same as full graph)", async () => {
  resetDataForTesting();
  await ensureData({ DATA: shardedBucket() });
  await ensureSectionsForQuery({ DATA: shardedBucket() }, "best python testing tool");
  const { cards } = answerCards("best python testing tool", 5);
  assert.ok(cards.length >= 1);
  assert.equal(cards[0].name, "pytest");
  assert.equal(cards[0].rating, 5);
  assert.equal(cards[0].freshness, "fresh");
});
await check("answerCards matches the full-fixture-graph top pick", async () => {
  // Same data both ways: full-graph path on the checked-in fixture graph,
  // vs the sharded path on shards built FROM that fixture graph by the
  // real scripts/build_shards.py. The top pick must agree.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync: readSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  resetDataForTesting();
  assert.ok(loadGraphData(JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url), "utf-8"))));
  const { loadSearchIndex } = await import("../src/tfidf");
  assert.ok(loadSearchIndex(JSON.parse(readFileSync(new URL("../data/search.json", import.meta.url), "utf-8"))));
  const full = answerCards("best python testing tool", 5);
  assert.ok(full.cards.length >= 1, "fixture graph should answer");
  const tmp = mkdtempSync(join(tmpdir(), "shards-test-"));
  try {
    execFileSync(
      "python3",
      ["scripts/build_shards.py", "worker/data/graph.json", "worker/data/search.json", "--out", tmp],
      { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf-8", timeout: 120_000 },
    );
    const files: Record<string, unknown> = {
      "catalog.json": JSON.parse(readSync(join(tmp, "catalog.json"), "utf-8")),
      "termmap.json": JSON.parse(readSync(join(tmp, "termmap.json"), "utf-8")),
    };
    for (const name of (await import("node:fs")).readdirSync(join(tmp, "shards"))) {
      files[`shards/${name}`] = JSON.parse(readSync(join(tmp, "shards", name), "utf-8"));
    }
    resetDataForTesting();
    const bucket = mockBucket(files);
    await ensureData({ DATA: bucket });
    await ensureSectionsForQuery({ DATA: bucket }, "best python testing tool");
    const sharded = answerCards("best python testing tool", 5);
    assert.ok(sharded.cards.length >= 1, "sharded path should answer");
    assert.equal(sharded.cards[0].name, full.cards[0].name);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log("\n[5] invalid / missing shard data never crashes");
await check("missing shard object -> section stays unloaded, no crash", async () => {
  resetDataForTesting();
  const bucket = mockBucket({ "catalog.json": tinyCatalog, "termmap.json": tinyTermmap });
  await ensureData({ DATA: bucket });
  const loaded = await ensureSections({ DATA: bucket }, ["Programming Languages"]);
  assert.deepEqual(loaded, []);
  assert.deepEqual(loadedShards(), []);
  assert.equal(getNode("item:pytest"), undefined);
});
await check("invalid shard JSON -> not loaded, no crash", async () => {
  resetDataForTesting();
  const bucket = mockBucket({
    "catalog.json": tinyCatalog,
    "termmap.json": tinyTermmap,
    "shards/programming-languages.json": { version: 99, nodes: "nope" },
  });
  await ensureData({ DATA: bucket });
  const loaded = await ensureSections({ DATA: bucket }, ["Programming Languages"]);
  assert.deepEqual(loaded, []);
});
await check("catalog missing -> legacy full-graph fallback still works", async () => {
  resetDataForTesting();
  const tinyGraph = {
    meta: { repoCount: 1, nodeCount: 3, edgeCount: 2 },
    nodes: [
      { id: "repo:awesome-python", type: "repo", fullName: "vinta/awesome-python", description: "Awesome Python list", language: "Python", stars: 1000, forks: 10, url: "https://github.com/vinta/awesome-python", pushedAt: RECENT },
      { id: "item:pytest", type: "item", name: "pytest", description: "Python testing framework", url: "https://github.com/pytest-dev/pytest" },
      { id: "list:awesome-python", type: "list", name: "awesome-python", section: "Programming Languages" },
    ],
    edges: [
      { source: "item:pytest", target: "list:awesome-python", type: "LISTED_IN" },
      { source: "item:pytest", target: "repo:awesome-python", type: "LISTED_IN" },
    ],
  };
  const tinySearch = {
    version: 1,
    terms: { pytest: { idf: 1.0, postings: [["item:pytest", 1.0]] } },
    norms: { "item:pytest": 1.0 },
  };
  const s = await ensureData({ DATA: mockBucket({ "graph.json": tinyGraph, "search.json": tinySearch }) });
  assert.deepEqual(s, { graph: true, search: true, sharded: false, shards: [] });
  assert.equal(getNode("item:pytest")?.name, "pytest");
  assert.equal(tfidfSearch("pytest")[0]?.id, "item:pytest");
});

console.log("\n[6] HTTP flow (worker.fetch) over a mocked sharded R2");
async function post(path: string, body: unknown, env: unknown) {
  const res = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env as never,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function get(path: string, env: unknown) {
  const res = await worker.fetch(new Request(`https://example.com${path}`), env as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
await check("POST /api/answer returns pytest; health meta populated; trending/categories non-empty", async () => {
  resetDataForTesting();
  const env = { DATA: shardedBucket() };
  const ans = await post("/api/answer", { question: "best python testing tool" }, env);
  assert.equal(ans.status, 200);
  const cards = ans.body.cards as { name: string }[];
  assert.ok(Array.isArray(cards) && cards.length >= 1);
  assert.equal(cards[0].name, "pytest");
  const health = await get("/api/health", env);
  assert.equal(health.status, 200);
  assert.equal((health.body.meta as { nodeCount: number }).nodeCount, 4);
  const tr = await get("/api/trending", env);
  assert.ok(Array.isArray(tr.body.items) && (tr.body.items as unknown[]).length === 1);
  const cat = await get("/api/categories", env);
  assert.ok(Array.isArray(cat.body.categories) && (cat.body.categories as unknown[]).length === 1);
});
await check("POST /mcp search_best_tool matches /api/answer ranking", async () => {
  resetDataForTesting();
  const env = { DATA: shardedBucket() };
  const ans = await post("/api/answer", { question: "best python testing tool" }, env);
  const mcp = await post(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_best_tool", arguments: { query: "best python testing tool", limit: 5 } } },
    env,
  );
  assert.equal(mcp.status, 200);
  const result = mcp.body.result as { content: { text: string }[] };
  const payload = JSON.parse(result.content[0].text) as { bestPick: string; tools: { name: string }[] };
  assert.equal(payload.bestPick, "pytest");
  assert.equal(payload.tools[0]?.name, (ans.body.cards as { name: string }[])[0]?.name);
});
await check("POST /mcp get_tool_details resolves pytest by name", async () => {
  resetDataForTesting();
  const env = { DATA: shardedBucket() };
  const mcp = await post(
    "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_tool_details", arguments: { name: "pytest" } } },
    env,
  );
  assert.equal(mcp.status, 200);
  const result = mcp.body.result as { content: { text: string }[] };
  const payload = JSON.parse(result.content[0].text) as { name: string; rating: number };
  assert.equal(payload.name, "pytest");
  assert.equal(payload.rating, 5);
});

console.log("\n[8] browser-defect fixes (heading count, why text, expand edges)");
await check("answerCards label count equals the number of cards returned", async () => {
  resetDataForTesting();
  const env = { DATA: shardedBucket() };
  const ans = await post("/api/answer", { question: "best python testing tool" }, env);
  assert.equal(ans.status, 200);
  const label = ans.body.label as string;
  const cards = ans.body.cards as unknown[];
  const m = /^Top (\d+) tools for “(.+)”$/.exec(label);
  assert.ok(m, `expected "Top N tools for ..." label, got: ${label}`);
  assert.equal(Number(m[1]), cards.length, `label says ${m[1]} but ${cards.length} cards returned`);
});
await check("buildWhyText names where each term matched (name vs description)", () => {
  const descOnly = buildWhyText(
    { id: "item:pytest", type: "item", name: "pytest", description: "Python testing framework", lastActivity: RECENT },
    ["testing"],
  );
  assert.ok(descOnly.includes("Matches 'testing' in description"), descOnly);
  const nameHit = buildWhyText(
    { id: "item:python-tool", type: "item", name: "python-tool", description: "A handy tool", lastActivity: RECENT },
    ["python"],
  );
  assert.ok(nameHit.includes("Matches 'python' in name"), nameHit);
  // a term matched in the name is not repeated for the description
  const both = buildWhyText(
    { id: "item:playwright-python", type: "item", name: "playwright-python", description: "Python testing library", lastActivity: RECENT },
    ["python", "testing"],
  );
  assert.ok(both.includes("Matches 'python' in name"), both);
  assert.ok(both.includes("Matches 'testing' in description"), both);
});
await check("subgraphFromRoots keeps 1-hop edges to newly added neighbours", () => {
  resetDataForTesting();
  loadGraphData(tinyShard as never);
  const sg = subgraphFromRoots(["list:awesome-python"]);
  assert.equal(sg.nodes.length, 3, `expected list + 2 items, got ${sg.nodes.length}`);
  assert.equal(sg.edges.length, 2, `expected 2 LISTED_IN edges, got ${sg.edges.length}`);
  assert.ok(sg.edges.every((e) => e.type === "LISTED_IN"));
});
await check("GET /api/expand?id=item:pytest returns the item, its list, and the edge (fresh isolate)", async () => {
  resetDataForTesting();
  const env = { DATA: shardedBucket() };
  const res = await get("/api/expand?id=item:pytest", env);
  assert.equal(res.status, 200);
  const sg = res.body.subgraph as { nodes: { id: string }[]; edges: { source: string; target: string }[] };
  assert.ok(sg.nodes.some((n) => n.id === "item:pytest"), `item missing: ${JSON.stringify(sg.nodes)}`);
  assert.ok(sg.nodes.some((n) => n.id === "list:awesome-python"), `list missing: ${JSON.stringify(sg.nodes)}`);
  assert.equal(sg.edges.length, 1, `expected 1 LISTED_IN edge, got ${sg.edges.length}`);
});
await check("GET /api/expand?id=list:awesome-python returns 2 items and 2 edges", async () => {
  resetDataForTesting();
  const env = { DATA: shardedBucket() };
  const res = await get("/api/expand?id=list:awesome-python", env);
  assert.equal(res.status, 200);
  const sg = res.body.subgraph as { nodes: { id: string }[]; edges: unknown[] };
  assert.equal(sg.nodes.length, 3, `expected list + 2 items, got ${sg.nodes.length}`);
  assert.equal(sg.edges.length, 2, `expected 2 LISTED_IN edges, got ${sg.edges.length}`);
});
await check("ensureSectionsForNode loads the shard for an item id without the node pre-loaded", async () => {
  resetDataForTesting();
  const env = { DATA: shardedBucket() };
  await ensureData(env);
  assert.equal(getNode("item:pytest"), undefined, "item should not be in the skeleton");
  const loaded = await ensureSectionsForNode(env, "item:pytest");
  assert.ok(loaded.includes("programming-languages"), `expected programming-languages loaded, got ${loaded}`);
  assert.ok(getNode("item:pytest"), "item should be loaded after ensureSectionsForNode");
});

console.log(`\nSHARDS: ${passed} CHECKS PASSED, ${failed} FAILED\n`);
if (failed > 0) process.exitCode = 1;
