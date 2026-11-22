// v2 suite — rating/freshness, TF-IDF, no-key endpoints, AI cap fallback.
// Run: npm test (smoke.test.ts && v2.test.ts). Uses only node:assert + tsx.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, buildWhyText, isTfidfEnabled, parseSearchJson, searchWithIndex, tfidfSearch, timeAgo } from "../src/tfidf";
import { compareRanked, nodeRating, rateNode } from "../src/rating";
import { answerCards, trending } from "../src/retrieval";
import { allLists, sectionsWithCounts } from "../src/graph";
import worker, { answerLlm, resetAiCapsForTesting } from "../src/index";

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

const DAY_MS = 86_400_000;
function monthsAgo(m: number): string {
  return new Date(Date.now() - m * 30.44 * DAY_MS).toISOString();
}
const RECENT = new Date(Date.now() - 10 * DAY_MS).toISOString();

console.log("\n[1] rating bands");
await check("archived -> 1/outdated", () => {
  assert.deepEqual(rateNode({ archived: true, lastActivity: RECENT, stars: 50000 }), { rating: 1, freshness: "outdated" });
});
await check("recent + 1200 stars -> 5", () => {
  assert.deepEqual(rateNode({ lastActivity: RECENT, stars: 1200 }), { rating: 5, freshness: "fresh" });
});
await check("recent + 10 stars -> 4", () => {
  assert.deepEqual(rateNode({ lastActivity: RECENT, stars: 10 }), { rating: 4, freshness: "fresh" });
});
await check("8mo + 2000 stars -> 4, 8mo + 10 stars -> 3", () => {
  assert.deepEqual(rateNode({ lastActivity: monthsAgo(8), stars: 2000 }), { rating: 4, freshness: "fresh" });
  assert.deepEqual(rateNode({ lastActivity: monthsAgo(8), stars: 10 }), { rating: 3, freshness: "fresh" });
});
await check("18mo old -> 3", () => {
  assert.deepEqual(rateNode({ lastActivity: monthsAgo(18), stars: 50000 }), { rating: 3, freshness: "stale" });
});
await check("3yr old -> 2", () => {
  assert.deepEqual(rateNode({ lastActivity: monthsAgo(36), stars: 50000 }), { rating: 2, freshness: "stale" });
});
await check("5yr old -> 1", () => {
  assert.deepEqual(rateNode({ lastActivity: monthsAgo(60), stars: 50000 }), { rating: 1, freshness: "outdated" });
});
await check("no date -> 2/stale", () => {
  assert.deepEqual(rateNode({ stars: 50000 }), { rating: 2, freshness: "stale" });
  assert.deepEqual(rateNode({}), { rating: 2, freshness: "stale" });
});

console.log("\n[2] freshness boundaries");
await check("11mo fresh, 12.5mo stale, 47.5mo stale, 48.5mo outdated", () => {
  assert.equal(rateNode({ lastActivity: monthsAgo(11) }).freshness, "fresh");
  assert.equal(rateNode({ lastActivity: monthsAgo(12.5) }).freshness, "stale");
  assert.equal(rateNode({ lastActivity: monthsAgo(47.5) }).freshness, "stale");
  assert.equal(rateNode({ lastActivity: monthsAgo(48.5) }).freshness, "outdated");
});

console.log("\n[3] nodeRating: stored wins, else derive (pushedAt fallback)");
await check("stored rating/freshness returned as-is", () => {
  const r = nodeRating({ id: "x", type: "repo", rating: 5, freshness: "fresh", archived: true } as never);
  assert.deepEqual(r, { rating: 5, freshness: "fresh" });
});
await check("derives from pushedAt when lastActivity is absent", () => {
  const r = nodeRating({ id: "x", type: "repo", pushedAt: RECENT, stars: 5000 });
  assert.deepEqual(r, { rating: 5, freshness: "fresh" });
});
await check("no date anywhere -> 2/stale", () => {
  assert.deepEqual(nodeRating({ id: "x", type: "item", name: "NoDate" }), { rating: 2, freshness: "stale" });
});

console.log("\n[4] compareRanked ordering");
await check("archived last, fresh first, rating desc, stars desc", () => {
  const mk = (id: string, o: Record<string, unknown>) => ({ id, type: "repo", ...o }) as never;
  const archived = mk("archived", { archived: true, lastActivity: RECENT, stars: 99999 });
  const fresh5 = mk("fresh5", { lastActivity: RECENT, stars: 2000 });
  const fresh4 = mk("fresh4", { lastActivity: RECENT, stars: 10 });
  const stale3 = mk("stale3", { lastActivity: monthsAgo(18), stars: 99999 });
  const outdated1 = mk("outdated1", { lastActivity: monthsAgo(60), stars: 99999 });
  const sorted = [archived, stale3, outdated1, fresh4, fresh5].sort(compareRanked).map((n) => (n as { id: string }).id);
  assert.deepEqual(sorted, ["fresh5", "fresh4", "stale3", "outdated1", "archived"]);
});
await check("stars break rating ties", () => {
  const mk = (id: string, stars: number) => ({ id, type: "repo", lastActivity: RECENT, stars }) as never;
  const sorted = [mk("low", 100), mk("high", 9000)].sort(compareRanked).map((n) => (n as { id: string }).id);
  assert.deepEqual(sorted, ["high", "low"]);
});
await check("archived: undefined must NOT beat archived: false (fresh repo first)", () => {
  // Regression: `undefined !== false` made dateless items sort above fresh repos.
  const freshRepo = { id: "fresh-repo", type: "repo", archived: false, lastActivity: RECENT, stars: 5000 } as never;
  const staleItem = { id: "stale-item", type: "item", name: "Stale" } as never;
  const archivedRepo = { id: "archived-repo", type: "repo", archived: true, lastActivity: RECENT, stars: 99999 } as never;
  const sorted = [staleItem, archivedRepo, freshRepo].sort(compareRanked).map((n) => (n as { id: string }).id);
  assert.deepEqual(sorted, ["fresh-repo", "stale-item", "archived-repo"]);
});

console.log("\n[5] TF-IDF: pure builder");
const tinyDocs = [
  { id: "item:pytest", text: "pytest Python testing framework" },
  { id: "item:vitest", text: "vitest JavaScript testing framework" },
  { id: "repo:awesome-python", text: "awesome Python list" },
];
const tinyIndex = buildIndex(tinyDocs);
await check('"python testing" ranks the python-testing doc first', () => {
  const hits = searchWithIndex(tinyIndex, "python testing");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "item:pytest");
});
await check('synonym "js" matches javascript docs', () => {
  const hits = searchWithIndex(tinyIndex, "js");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "item:vitest");
});
await check("unknown query -> no hits; empty index -> no hits", () => {
  assert.deepEqual(searchWithIndex(tinyIndex, "zzzzqq"), []);
  assert.deepEqual(searchWithIndex(null, "python"), []);
});
await check("buildIndex norms are positive and postings are weighted", () => {
  for (const id of ["item:pytest", "item:vitest", "repo:awesome-python"]) {
    assert.ok(tinyIndex.norms[id] > 0, `norm for ${id}`);
  }
  assert.ok(tinyIndex.terms["python"].postings.length === 2);
});

console.log("\n[6] TF-IDF: search.json loader (fixture + invalid shapes)");
await check("fixture search.json parses and ranks pytest first", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf-8"));
  const idx = parseSearchJson(raw);
  assert.ok(idx !== null, "fixture should parse");
  const hits = searchWithIndex(idx, "python testing");
  assert.equal(hits[0].id, "item:pytest");
});
await check("invalid shapes -> null (never throws)", () => {
  assert.equal(parseSearchJson(null), null);
  assert.equal(parseSearchJson({}), null);
  assert.equal(parseSearchJson({ version: 2, terms: {}, norms: {} }), null);
  assert.equal(parseSearchJson({ version: 1, terms: { x: { idf: "bad", postings: [] } }, norms: {} }), null);
  assert.equal(parseSearchJson({ version: 1, terms: {}, norms: { a: "bad" } }), null);
});
await check("tfidfSearch degrades gracefully (array, no throw)", () => {
  const hits = tfidfSearch("python testing");
  assert.ok(Array.isArray(hits), "must return an array even with an empty/missing index");
  assert.equal(typeof isTfidfEnabled(), "boolean");
});

console.log("\n[7] TF-IDF: absent search.json file (subprocess, real loader)");
await check("loader with NO search.json -> disabled, tfidfSearch returns []", () => {
  const dir = mkdtempSync(join(tmpdir(), "graphrag-tfidf-absent-"));
  try {
    cpSync(new URL("../src", import.meta.url), join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(dir, "runner.mts"),
      [
        'import assert from "node:assert/strict";',
        'import { tfidfSearch, isTfidfEnabled } from "./src/tfidf.ts";',
        "assert.equal(isTfidfEnabled(), false);",
        'assert.deepEqual(tfidfSearch("python testing"), []);',
        'console.log("absent-file degradation OK");',
        "",
      ].join("\n"),
    );
    const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const out = execFileSync(process.execPath, [tsxCli, "runner.mts"], { cwd: dir, timeout: 60_000, encoding: "utf-8" });
    assert.ok(out.includes("absent-file degradation OK"), `unexpected runner output: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\n[8] no-key endpoints (live fetch handler, no Worker runtime)");
const post = (path: string, body: unknown, env: unknown = {}, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env as never,
  );
const get = (path: string, env: unknown = {}) => worker.fetch(new Request(`http://localhost${path}`), env as never);

await check('POST /api/answer "best python testing tool" -> ranked cards, items first', async () => {
  const res = await post("/api/answer", { question: "best python testing tool" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { label: string; cards: Record<string, unknown>[] };
  assert.ok(typeof body.label === "string" && body.label.length > 0);
  // 7 candidates exist on the current graph (5 Python repos + 2 python items);
  // the endpoint returns what exists, up to the limit — it never invents cards.
  assert.ok(Array.isArray(body.cards) && body.cards.length > 0 && body.cards.length <= 10, `expected 1-10 cards, got ${body.cards.length}`);
  body.cards.forEach((c, i) => {
    assert.equal(c.rank, i + 1);
    assert.ok(typeof c.id === "string" && typeof c.name === "string");
    assert.ok(typeof c.rating === "number" && (c.rating as number) >= 1 && (c.rating as number) <= 5);
    assert.ok(["fresh", "stale", "outdated"].includes(c.freshness as string));
    assert.ok(typeof c.why === "string");
  });
  assert.equal(body.cards[0].type, "item", "matching items surface first");
  assert.ok(body.cards.some((c) => c.type === "item" && typeof c.listName === "string"), "item cards carry listName");
  // every item card precedes every repo card
  const lastItem = Math.max(-1, ...body.cards.map((c, i) => (c.type === "item" ? i : -1)));
  const firstRepo = body.cards.findIndex((c) => c.type === "repo");
  assert.ok(firstRepo === -1 || lastItem < firstRepo, "items-first ordering violated");
});
await check("POST /api/answer validates question + limit", async () => {
  assert.equal((await post("/api/answer", {})).status, 400);
  assert.equal((await post("/api/answer", { question: "" })).status, 400);
  assert.equal((await post("/api/answer", { question: "x".repeat(501) })).status, 400);
  assert.equal((await post("/api/answer", { question: "top repos", limit: "x" })).status, 400);
  const res = await post("/api/answer", { question: "top repos", limit: 2 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cards: unknown[] };
  assert.equal(body.cards.length, 2);
});
await check("GET /api/trending -> 10 ranked items", async () => {
  const res = await get("/api/trending");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Record<string, unknown>[] };
  assert.equal(body.items.length, 10);
  body.items.forEach((c, i) => assert.equal(c.rank, i + 1));
  assert.equal(body.items[0].freshness, "fresh", "top trending card is fresh");
  assert.ok((body.items[0].rating as number) >= 4, "top trending card is highly rated");
  assert.ok(body.items.every((c) => ["fresh", "stale", "outdated"].includes(c.freshness as string)));
});
await check("GET /api/categories -> sections with counts", async () => {
  const res = await get("/api/categories");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { categories: { name: string; listCount: number; itemCount: number }[] };
  assert.ok(Array.isArray(body.categories) && body.categories.length > 0);
  for (const c of body.categories) {
    assert.ok(typeof c.name === "string" && c.name.length > 0);
    assert.ok(typeof c.listCount === "number" && typeof c.itemCount === "number" && c.itemCount > 0);
  }
  if (allLists().length === 0) {
    assert.equal(body.categories.length, 12, "no list nodes yet -> top-12-topic fallback");
    assert.ok(body.categories.every((c) => c.listCount === 0));
  }
});
await check("answerCards / trending direct calls", () => {
  const a = answerCards("best python testing tool", 5);
  assert.equal(a.cards.length, 5);
  assert.ok(a.label.length > 0);
  assert.equal(trending(5).length, 5);
  assert.equal(sectionsWithCounts().length, 12);
});

console.log("\n[9] buildWhyText builds only from real fields");
await check('example shape: "Matches \'testing\' · Python · ★12.4k · updated …"', () => {
  const why = buildWhyText(
    { id: "x", type: "repo", name: "pytest", description: "Python testing framework", language: "Python", stars: 12400, lastActivity: RECENT },
    ["testing"],
  );
  assert.ok(why.includes("Matches 'testing'"), why);
  assert.ok(why.includes("Python"), why);
  assert.ok(why.includes("★12.4k"), why);
  assert.ok(why.includes(`updated ${timeAgo(RECENT)}`), why);
});
await check("no fields -> description fallback, never invented", () => {
  const why = buildWhyText({ id: "x", type: "item", name: "Nope", description: "Just a thing" }, ["zzz"]);
  assert.equal(why, "Just a thing");
});

console.log("\n[10] Workers AI cap fallback");
const fakeAI = { run: async () => ({ response: "fake ai answer" }) };
await check("no AI binding -> 501", async () => {
  resetAiCapsForTesting();
  const r = await answerLlm("top repos", {}, "1.2.3.4");
  assert.equal(r.status, 501);
  assert.deepEqual(r.body, { error: "AI not configured" });
});
await check("global daily cap hit -> 200 template answer", async () => {
  resetAiCapsForTesting();
  const env = { AI: fakeAI, AI_DAILY_CAP: "1" };
  const first = await answerLlm("top repos", env, "1.2.3.4");
  assert.equal(first.status, 200);
  assert.equal((first.body as { source: string }).source, "ai");
  assert.equal((first.body as { answer: string }).answer, "fake ai answer");
  const second = await answerLlm("top repos", env, "1.2.3.4");
  assert.equal(second.status, 200);
  assert.equal((second.body as { source: string }).source, "template");
  assert.ok(Array.isArray((second.body as { cards: unknown[] }).cards));
});
await check("per-IP 20/day -> 21st call falls back to template", async () => {
  resetAiCapsForTesting();
  const env = { AI: fakeAI };
  for (let i = 0; i < 20; i++) {
    const r = await answerLlm("top repos", env, "5.6.7.8");
    assert.equal((r.body as { source: string }).source, "ai", `call ${i + 1} should use AI`);
  }
  const r21 = await answerLlm("top repos", env, "5.6.7.8");
  assert.equal((r21.body as { source: string }).source, "template");
});
await check("POST /api/answer-llm without AI -> 501 (HTTP level)", async () => {
  resetAiCapsForTesting();
  const res = await post("/api/answer-llm", { question: "top repos" }, {});
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: "AI not configured" });
});
await check("POST /api/answer-llm with fake AI -> 200 ai answer (HTTP level)", async () => {
  resetAiCapsForTesting();
  const res = await post("/api/answer-llm", { question: "top repos" }, { AI: fakeAI }, { "CF-Connecting-IP": "9.9.9.9" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { source: string; answer: string; cards: unknown[] };
  assert.equal(body.source, "ai");
  assert.equal(body.answer, "fake ai answer");
  assert.ok(Array.isArray(body.cards));
});

console.log(`\nV2: ${passed} CHECKS PASSED, ${failed} FAILED\n`);
if (failed > 0) process.exit(1);
