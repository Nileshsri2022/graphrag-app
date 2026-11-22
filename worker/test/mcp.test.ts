// MCP suite — the /mcp endpoint (Streamable HTTP, JSON-RPC 2.0) and the
// 5 MCP tools. Run: npm test (smoke.test.ts && v2.test.ts && mcp.test.ts).
// Uses only node:assert + tsx; no external test framework.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { loadGraphData } from "../src/graph";
import { loadSearchIndex } from "../src/tfidf";
import { answerCards } from "../src/retrieval";
import { MCP_TOOLS, inferInstallCommand } from "../src/mcp";

// The worker loads its data from R2 at cold start (nothing is bundled); tests
// load the checked-in fixtures (worker/data/*) explicitly instead.
function loadFixtures(): void {
  assert.ok(
    loadGraphData(JSON.parse(readFileSync(new URL("../data/graph.json", import.meta.url), "utf-8"))),
    "fixture graph.json should load",
  );
  assert.ok(
    loadSearchIndex(JSON.parse(readFileSync(new URL("../data/search.json", import.meta.url), "utf-8"))),
    "fixture search.json should load",
  );
}
loadFixtures();

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

let ipN = 0;
async function postMcp(body: unknown): Promise<{ status: number; json: () => Promise<unknown> }> {
  ipN += 1;
  const res = await worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": `10.2.0.${ipN}`,
      },
      body: JSON.stringify(body),
    }),
    {} as never,
  );
  return res as unknown as { status: number; json: () => Promise<unknown> };
}

async function rpc(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await postMcp(body);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

function callTool(name: string, args: Record<string, unknown>, id = 1): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** Parse the {content:[{type:"text", text: <JSON>}]} payload of a tools/call result. */
function toolPayload(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

const FRESH = new Set(["fresh", "stale", "outdated"]);

console.log("\n[1] MCP handshake + lifecycle");
await check("initialize returns protocolVersion, capabilities.tools, serverInfo", async () => {
  const { status, data } = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(status, 200);
  assert.equal(data.jsonrpc, "2.0");
  const result = data.result as Record<string, unknown>;
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal((result.serverInfo as Record<string, unknown>).name, "graphrag-app");
  assert.equal(typeof result.instructions, "string");
});
await check("initialize with an unsupported protocol version negotiates down", async () => {
  const { data } = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal((data.result as Record<string, unknown>).protocolVersion, "2025-03-26");
});
await check("ping returns {}", async () => {
  const { data } = await rpc({ jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(data.result, {});
});
await check("notifications/initialized (no id) -> 202, empty body", async () => {
  const res = await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.json().catch(() => ""), "");
});
await check("unknown method -> JSON-RPC -32601", async () => {
  const { data } = await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.equal((data.error as Record<string, unknown>).code, -32601);
});
await check("malformed JSON body -> -32700 Parse error", async () => {
  ipN += 1;
  const res = await worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.2.0.${ipN}` },
      body: "{not json",
    }),
    {} as never,
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32700);
});
await check("GET /mcp -> 405", async () => {
  ipN += 1;
  const res = await worker.fetch(new Request("http://localhost/mcp", { headers: { "CF-Connecting-IP": `10.2.0.${ipN}` } }), {} as never);
  assert.equal(res.status, 405);
});

console.log("\n[2] tools/list");
await check("tools/list returns the 5 tools with input schemas", async () => {
  const { data } = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/list" });
  const tools = (data.result as { tools: { name: string; inputSchema: { required?: string[] } }[] }).tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    ["search_best_tool", "get_tool_details", "compare_tools", "find_awesome_section", "get_trending_tools"],
  );
  assert.deepEqual(MCP_TOOLS.map((t) => t.name), tools.map((t) => t.name));
  for (const t of tools) {
    assert.equal(typeof t.inputSchema, "object");
    assert.equal(t.inputSchema.type, "object");
  }
  assert.deepEqual(tools[0].inputSchema.required, ["query"]);
});

console.log("\n[3] tools/call: search_best_tool");
await check("search_best_tool mirrors /api/answer ranking + rating/freshness", async () => {
  const { data } = await rpc(callTool("search_best_tool", { query: "best python testing tool" }, 20));
  assert.equal(data.error, undefined);
  const payload = toolPayload(data.result as Record<string, unknown>);
  const expected = answerCards("best python testing tool", 5);
  const tools = payload.tools as { rank: number; name: string; rating: number; freshness: string; reason: string }[];
  assert.equal(tools.length, 5);
  assert.equal(payload.bestPick, tools[0].name);
  assert.equal(tools[0].name, expected.cards[0].name);
  assert.deepEqual(
    tools.map((t) => t.name),
    expected.cards.map((c) => c.name),
  );
  for (let i = 0; i < tools.length; i += 1) {
    assert.equal(tools[i].rank, i + 1);
    assert.ok(Number.isInteger(tools[i].rating) && tools[i].rating >= 1 && tools[i].rating <= 5);
    assert.ok(FRESH.has(tools[i].freshness));
    assert.equal(typeof tools[i].reason, "string");
  }
});
await check("search_best_tool validates query (missing -> -32602)", async () => {
  const { data } = await rpc(callTool("search_best_tool", {}, 21));
  assert.equal((data.error as Record<string, unknown>).code, -32602);
});
await check("search_best_tool respects limit", async () => {
  const { data } = await rpc(callTool("search_best_tool", { query: "python", limit: 2 }, 22));
  const payload = toolPayload(data.result as Record<string, unknown>);
  assert.equal((payload.tools as unknown[]).length, 2);
});

console.log("\n[4] tools/call: get_tool_details + compare_tools");
await check("get_tool_details by repo fullName -> rating 5, fresh, no guessed install command", async () => {
  const { data } = await rpc(callTool("get_tool_details", { name: "sindresorhus/awesome" }, 30));
  assert.equal(data.error, undefined);
  assert.equal((data.result as Record<string, unknown>).isError, undefined);
  const payload = toolPayload(data.result as Record<string, unknown>);
  assert.equal(payload.found, true);
  assert.equal(payload.name, "sindresorhus/awesome");
  assert.equal(payload.rating, 5);
  assert.equal(payload.freshness, "fresh");
  assert.ok(typeof payload.stars === "number" && (payload.stars as number) > 0);
  // GitHub URL: install command must be omitted, never guessed.
  assert.equal("installCommand" in payload, false);
  assert.ok(Array.isArray(payload.alternatives));
});
await check("get_tool_details unknown name -> isError, not a JSON-RPC error", async () => {
  const { data } = await rpc(callTool("get_tool_details", { name: "definitely-not-a-real-tool-xyz" }, 31));
  assert.equal(data.error, undefined);
  const result = data.result as Record<string, unknown>;
  assert.equal(result.isError, true);
  const payload = toolPayload(result);
  assert.match((payload.error as string), /no tool found/);
});
await check("get_tool_details with neither name nor url -> -32602", async () => {
  const { data } = await rpc(callTool("get_tool_details", {}, 32));
  assert.equal((data.error as Record<string, unknown>).code, -32602);
});
await check("compare_tools compares 2 repos + summary names the highest-ranked", async () => {
  const { data } = await rpc(
    callTool("compare_tools", { tools: ["sindresorhus/awesome", "sindresorhus/awesome-nodejs"] }, 33),
  );
  const payload = toolPayload(data.result as Record<string, unknown>);
  const tools = payload.tools as { found: boolean; name: string; rating: number; freshness: string }[];
  assert.equal(tools.length, 2);
  assert.ok(tools.every((t) => t.found));
  assert.ok(tools.every((t) => Number.isInteger(t.rating) && FRESH.has(t.freshness)));
  assert.match((payload.summary as string), /ranks highest/);
});
await check("compare_tools with 1 tool -> -32602", async () => {
  const { data } = await rpc(callTool("compare_tools", { tools: ["pytest"] }, 34));
  assert.equal((data.error as Record<string, unknown>).code, -32602);
});
await check("compare_tools marks an unknown tool found:false, keeps the rest", async () => {
  const { data } = await rpc(
    callTool("compare_tools", { tools: ["sindresorhus/awesome", "definitely-not-a-real-tool-xyz"] }, 35),
  );
  const payload = toolPayload(data.result as Record<string, unknown>);
  const tools = payload.tools as { found: boolean }[];
  assert.equal(tools[0].found, true);
  assert.equal(tools[1].found, false);
});

console.log("\n[5] tools/call: find_awesome_section + get_trending_tools");
await check("find_awesome_section 'nodejs' -> topic fallback with itemCount", async () => {
  const { data } = await rpc(callTool("find_awesome_section", { query: "nodejs" }, 40));
  const payload = toolPayload(data.result as Record<string, unknown>);
  const sections = payload.sections as { type: string; name: string; itemCount: number }[];
  assert.ok(sections.length >= 1);
  assert.equal(sections[0].name, "nodejs");
  assert.ok(sections[0].itemCount > 0);
});
await check("get_trending_tools -> 10 ranked tools with rating+freshness", async () => {
  const { data } = await rpc(callTool("get_trending_tools", {}, 41));
  const payload = toolPayload(data.result as Record<string, unknown>);
  const tools = payload.tools as { rating: number; freshness: string }[];
  assert.equal(tools.length, 10);
  assert.ok(tools.every((t) => Number.isInteger(t.rating) && FRESH.has(t.freshness)));
});
await check("get_trending_tools category 'javascript' + limit 3", async () => {
  const { data } = await rpc(callTool("get_trending_tools", { category: "javascript", limit: 3 }, 42));
  const payload = toolPayload(data.result as Record<string, unknown>);
  assert.equal(payload.category, "javascript");
  assert.equal((payload.tools as unknown[]).length, 3);
});

console.log("\n[6] errors + install-command inference + existing routes");
await check("tools/call unknown tool -> JSON-RPC -32602", async () => {
  const { data } = await rpc(callTool("no_such_tool", {}, 50));
  assert.equal((data.error as Record<string, unknown>).code, -32602);
  assert.match((data.error as Record<string, unknown>).message as string, /Unknown tool/);
});
await check("batch [initialize, tools/list] returns an array of 2 responses", async () => {
  const res = await postMcp([
    { jsonrpc: "2.0", id: 60, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 61, method: "tools/list" },
  ]);
  assert.equal(res.status, 200);
  const arr = (await res.json()) as { id: number; result: unknown }[];
  assert.equal(arr.length, 2);
  assert.deepEqual(
    arr.map((r) => r.id),
    [60, 61],
  );
});
await check("inferInstallCommand: registries only, never GitHub", () => {
  assert.equal(inferInstallCommand("https://pypi.org/project/pytest/"), "pip install pytest");
  assert.equal(inferInstallCommand("https://www.npmjs.com/package/@scope/name"), "npm install @scope/name");
  assert.equal(inferInstallCommand("https://crates.io/crates/serde"), "cargo add serde");
  assert.equal(inferInstallCommand("https://rubygems.org/gems/rails"), "gem install rails");
  assert.equal(inferInstallCommand("https://github.com/psf/requests"), undefined);
  assert.equal(inferInstallCommand("https://docs.npmjs.com"), undefined);
  assert.equal(inferInstallCommand(undefined), undefined);
});
await check("POST /api/answer still works and matches the MCP best pick", async () => {
  ipN += 1;
  const res = await worker.fetch(
    new Request("http://localhost/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.2.0.${ipN}` },
      body: JSON.stringify({ question: "best python testing tool", limit: 5 }),
    }),
    {} as never,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cards: { name: string }[] };
  assert.equal(body.cards.length, 5);
  assert.equal(body.cards[0].name, answerCards("best python testing tool", 5).cards[0].name);
});
await check("GET /api/health still ok", async () => {
  ipN += 1;
  const res = await worker.fetch(
    new Request("http://localhost/api/health", { headers: { "CF-Connecting-IP": `10.2.0.${ipN}` } }),
    {} as never,
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

console.log(`\nMCP: ${passed} CHECKS PASSED, ${failed} FAILED\n`);
if (failed > 0) process.exit(1);
