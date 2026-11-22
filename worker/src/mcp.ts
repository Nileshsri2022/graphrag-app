// MCP (Model Context Protocol) server for the GraphRAG knowledge base.
//
// Exposes the same R2-backed graph + TF-IDF ranking as the /api/* routes
// over the standard MCP Streamable HTTP transport (JSON-RPC 2.0, POST /mcp),
// so AI agents (Claude, Cursor, VS Code) can use the knowledge base.
//
// The edge over context-awesome.com's MCP: our tools return QUALITY-ranked
// data (rating 1-5 + Fresh/Stale/Outdated + a "best pick"), not raw items.
//
// No new dependency: the MCP surface we need (initialize, tools/list,
// tools/call, ping) is a small, hand-rolled JSON-RPC handler. The MCP
// TypeScript SDK would add hundreds of KB to the bundle for the same
// behaviour, so it is deliberately NOT used. The server is stateless
// (no Mcp-Session-Id): it never initiates messages, so no session is needed.
//
// Wiring: src/index.ts routes POST /mcp here AFTER ensureData(env), so the
// graph + search index are loaded before any tool runs. The web UI and
// /api/* routes are untouched.

import {
  allItems,
  allLists,
  allRepos,
  findItemsByName,
  findNodeByName,
  getNode,
  itemsOfList,
  listOfItem,
  reposWithLanguage,
  sectionsWithCounts,
  type Node,
} from "./graph";
import { answerCards, trending } from "./retrieval";
import { compareRanked, nodeRating } from "./rating";
import { queryTerms } from "./tfidf";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A JSON-RPC error (returned as {error:{code,message}}). */
class McpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** A tool ran but the requested thing does not exist: returned as a result
 *  with isError:true (the call itself was well-formed). */
class McpToolFailure extends Error {}

function invalidParams(message: string): McpError {
  return new McpError(-32602, `Invalid params: ${message}`);
}

// ---------------------------------------------------------------------------
// Tool definitions (name, description, input JSON Schema)
// ---------------------------------------------------------------------------

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "search_best_tool",
    description:
      "Search the awesome-lists knowledge graph for the best tool for a task. Returns ranked tools with a 1-5 rating, freshness (fresh/stale/outdated), stars, last activity, the list each came from, and a one-line reason. The first result is the best pick. Use this first for any 'what tool should I use for X' question.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What the user wants to do, e.g. 'best python testing tool' or 'postgres orm for go'.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 5,
          description: "How many ranked tools to return (default 5).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_tool_details",
    description:
      "Full details for one tool: description, stars, last activity, rating (1-5), freshness, GitHub link, an install command when it can be derived confidently from a package-registry URL (pypi, npm, rubygems, crates, packagist), and up to 3 alternatives from the same list with equal or higher rating.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Tool name, e.g. 'pytest' or a repo full name like 'sindresorhus/awesome'.",
        },
        url: {
          type: "string",
          description: "Tool URL, e.g. a GitHub repo URL or a package-registry URL.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "compare_tools",
    description:
      "Compare 2-3 tools side by side: stars, last activity, rating (1-5), freshness and description for each, plus a one-line summary of which ranks highest.",
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 3,
          description: "2-3 tool names or URLs, e.g. ['pytest', 'nose2'].",
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
  },
  {
    name: "find_awesome_section",
    description:
      "Discover awesome lists / sections matching a query (same purpose as the context-awesome.com tool of the same name). Returns matching lists with name, description, stars and item count.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Topic to find lists for, e.g. 'machine learning' or 'rust'.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 10,
          description: "How many sections to return (default 10).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_trending_tools",
    description:
      "Trending tools right now (top items + repos by rating, stars and recency), optionally filtered by category (a language like 'python', or a list section name).",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional category filter, e.g. 'python' or 'javascript'. Omit for overall trending.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 10,
          description: "How many trending tools to return (default 10).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Argument validation helpers
// ---------------------------------------------------------------------------

function reqString(args: Record<string, unknown>, key: string, maxLen: number): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw invalidParams(`'${key}' must be a non-empty string`);
  }
  if (v.length > maxLen) {
    throw invalidParams(`'${key}' is too long (max ${maxLen} chars)`);
  }
  return v.trim();
}

function optString(args: Record<string, unknown>, key: string, maxLen: number): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    throw invalidParams(`'${key}' must be a non-empty string`);
  }
  if (v.length > maxLen) {
    throw invalidParams(`'${key}' is too long (max ${maxLen} chars)`);
  }
  return v.trim();
}

function optLimit(args: Record<string, unknown>, key: string, def: number, max: number): number {
  const v = args[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw invalidParams(`'${key}' must be a number`);
  }
  return Math.max(1, Math.min(max, Math.floor(v)));
}

// ---------------------------------------------------------------------------
// Shared output shaping
// ---------------------------------------------------------------------------

type ToolCard = {
  rank: number;
  name: string;
  type: string;
  url?: string;
  description?: string;
  stars?: number;
  lastActivity?: string;
  rating: number;
  freshness: "fresh" | "stale" | "outdated";
  list?: string;
  reason: string;
};

function cardToTool(c: {
  rank: number;
  name: string;
  type: string;
  url?: string;
  description?: string;
  stars?: number;
  lastActivity?: string;
  rating: number;
  freshness: "fresh" | "stale" | "outdated";
  listName?: string;
  why: string;
}): ToolCard {
  return {
    rank: c.rank,
    name: c.name,
    type: c.type,
    ...(c.url ? { url: c.url } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(typeof c.stars === "number" ? { stars: c.stars } : {}),
    ...(c.lastActivity ? { lastActivity: c.lastActivity } : {}),
    rating: c.rating,
    freshness: c.freshness,
    ...(c.listName ? { list: c.listName } : {}),
    reason: c.why,
  };
}

// ---------------------------------------------------------------------------
// Node lookup (shared by get_tool_details / compare_tools)
// ---------------------------------------------------------------------------

function normUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** Find a node by URL: exact URL match (items first, then repos), then a
 *  github.com/owner/repo URL matched against repo fullNames. */
function findByUrl(url: string): Node | undefined {
  const target = normUrl(url);
  for (const n of allItems()) {
    if (n.url && normUrl(n.url) === target) return n;
  }
  for (const n of allRepos()) {
    if (n.url && normUrl(n.url) === target) return n;
  }
  const gh = target.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\/.*)?$/);
  if (gh) {
    const full = gh[1].toLowerCase();
    return allRepos().find((r) => (r.fullName ?? "").toLowerCase() === full);
  }
  return undefined;
}

/** Find a node by name: best item-name match first, then an exact repo name.
 *  Repo fullNames (owner/repo) are not node ids in the v1 graph (the id is
 *  the bare repo name), so fullName is matched explicitly as a last resort. */
function resolveByName(name: string): Node | undefined {
  const items = findItemsByName(name);
  if (items.length > 0) return items[0];
  const byName = findNodeByName(name);
  if (byName) return byName;
  const lower = name.toLowerCase();
  return allRepos().find((r) => (r.fullName ?? "").toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Install command inference
// ---------------------------------------------------------------------------

// Only package-registry URLs give a CONFIDENT package name. A GitHub repo
// name is not a reliable package name (it may be an app, a list, or a
// library), so GitHub URLs never produce an install command — it is omitted
// instead of guessed.
const REGISTRY_INSTALL: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^https?:\/\/(?:www\.)?pypi\.org\/project\/([^/]+)\/?$/i, (m) => `pip install ${m[1]}`],
  [/^https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[^/]+\/)?[^/?#]+)/i, (m) => `npm install ${decodeURIComponent(m[1])}`],
  [/^https?:\/\/(?:www\.)?rubygems\.org\/gems\/([^/?#]+)/i, (m) => `gem install ${m[1]}`],
  [/^https?:\/\/(?:www\.)?crates\.io\/crates\/([^/?#]+)/i, (m) => `cargo add ${m[1]}`],
  [/^https?:\/\/(?:www\.)?packagist\.org\/packages\/([^/?#]+\/[^/?#]+)/i, (m) => `composer require ${m[1]}`],
];

export function inferInstallCommand(url?: string): string | undefined {
  if (!url) return undefined;
  for (const [re, fmt] of REGISTRY_INSTALL) {
    const m = url.match(re);
    if (m) return fmt(m);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Alternatives (same list, equal-or-higher rating)
// ---------------------------------------------------------------------------

function findAlternatives(node: Node, k = 3): { name: string; url?: string; rating: number; freshness: "fresh" | "stale" | "outdated"; stars?: number }[] {
  const { rating } = nodeRating(node);
  let pool: Node[] = [];
  if (node.type === "item") {
    const parent = listOfItem(node.id);
    if (parent) pool = itemsOfList(parent.id);
  } else if (node.type === "repo" && node.language) {
    pool = allRepos().filter((r) => r.language === node.language);
  }
  return pool
    .filter((n) => n.id !== node.id)
    .filter((n) => nodeRating(n).rating >= rating)
    .sort(compareRanked)
    .slice(0, k)
    .map((n) => {
      const r = nodeRating(n);
      return {
        name: n.name ?? n.fullName ?? n.id,
        ...(n.url ? { url: n.url } : {}),
        rating: r.rating,
        freshness: r.freshness,
        ...(typeof n.stars === "number" ? { stars: n.stars } : {}),
      };
    });
}

// ---------------------------------------------------------------------------
// Tool implementations (pure: they read the loaded in-memory graph)
// ---------------------------------------------------------------------------

function searchBestTool(args: Record<string, unknown>): unknown {
  const query = reqString(args, "query", 500);
  const limit = optLimit(args, "limit", 5, 20);
  const { label, cards } = answerCards(query, limit);
  return {
    bestPick: cards[0]?.name ?? null,
    label,
    tools: cards.map(cardToTool),
  };
}

function getToolDetails(args: Record<string, unknown>): unknown {
  const name = optString(args, "name", 200);
  const url = optString(args, "url", 500);
  if (!name && !url) {
    throw invalidParams("get_tool_details requires 'name' or 'url'");
  }
  let node: Node | undefined;
  if (url) node = findByUrl(url);
  if (!node && name) node = resolveByName(name);
  if (!node) {
    throw new McpToolFailure(`no tool found matching ${url ? `url '${url}'` : `name '${name}'`}`);
  }
  const { rating, freshness } = nodeRating(node);
  const parent = node.type === "item" ? listOfItem(node.id) : undefined;
  const installCommand = inferInstallCommand(node.url);
  return {
    found: true,
    name: node.name ?? node.fullName ?? node.id,
    type: node.type,
    url: node.url ?? null,
    description: node.description ?? null,
    stars: typeof node.stars === "number" ? node.stars : null,
    lastActivity: node.lastActivity ?? node.pushedAt ?? null,
    rating,
    freshness,
    list: parent ? (parent.name ?? parent.fullName ?? parent.id) : null,
    section: parent?.section ?? null,
    ...(installCommand ? { installCommand } : {}),
    alternatives: findAlternatives(node, 3),
  };
}

function compareTools(args: Record<string, unknown>): unknown {
  const tools = args.tools;
  if (!Array.isArray(tools) || tools.length < 2 || tools.length > 3) {
    throw invalidParams("'tools' must be an array of 2-3 tool names or URLs");
  }
  for (const t of tools) {
    if (typeof t !== "string" || t.trim().length === 0) {
      throw invalidParams("'tools' entries must be non-empty strings");
    }
  }
  const results = (tools as string[]).map((t) => {
    const query = t.trim();
    const node = /^https?:\/\//i.test(query) ? findByUrl(query) : resolveByName(query);
    if (!node) {
      return {
        query,
        found: false,
        name: query,
        url: null,
        description: null,
        stars: null,
        lastActivity: null,
        rating: null,
        freshness: null,
      };
    }
    const { rating, freshness } = nodeRating(node);
    return {
      query,
      found: true,
      name: node.name ?? node.fullName ?? node.id,
      url: node.url ?? null,
      description: node.description ?? null,
      stars: typeof node.stars === "number" ? node.stars : null,
      lastActivity: node.lastActivity ?? node.pushedAt ?? null,
      rating,
      freshness,
    };
  });
  const found = results.filter((r) => r.found && r.rating !== null);
  let summary: string | null = null;
  if (found.length >= 2) {
    const best = [...found].sort(
      (a, b) => (b.rating as number) - (a.rating as number) || (b.stars ?? 0) - (a.stars ?? 0),
    )[0];
    summary = `${best.name} ranks highest (rating ${best.rating}/5${best.stars ? `, ★${best.stars}` : ""}).`;
  }
  return { tools: results, summary };
}

function findAwesomeSection(args: Record<string, unknown>): unknown {
  const query = reqString(args, "query", 200);
  const limit = optLimit(args, "limit", 10, 20);
  const terms = queryTerms(query).filter((t) => t.length >= 2);
  const lists = allLists();
  const scored = lists
    .map((l) => {
      const hay = `${l.name ?? ""} ${l.description ?? ""} ${l.section ?? ""}`.toLowerCase();
      return { node: l, score: terms.filter((t) => hay.includes(t)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (b.node.stars ?? 0) - (a.node.stars ?? 0));
  if (scored.length > 0) {
    return {
      query,
      sections: scored.slice(0, limit).map(({ node }) => ({
        type: "list",
        name: node.name ?? node.id,
        ...(node.fullName ? { fullName: node.fullName } : {}),
        ...(node.description ? { description: node.description } : {}),
        ...(typeof node.stars === "number" ? { stars: node.stars } : {}),
        ...(node.section ? { section: node.section } : {}),
        itemCount: itemsOfList(node.id).length,
      })),
    };
  }
  // No list nodes (base graph fixture) or no list matched: fall back to the
  // graph's topic groupings, which sectionsWithCounts() already exposes.
  const topics = sectionsWithCounts().filter((s) =>
    terms.some((t) => s.name.toLowerCase().includes(t)),
  );
  return {
    query,
    sections: topics.slice(0, limit).map((s) => ({
      type: "topic",
      name: s.name,
      itemCount: s.itemCount,
    })),
  };
}

function getTrendingTools(args: Record<string, unknown>): unknown {
  const limit = optLimit(args, "limit", 10, 20);
  const category = optString(args, "category", 100);
  // Fetch more than the limit, filter, then slice — so a category filter
  // still returns up to `limit` tools instead of a near-empty page.
  let tools = trending(50);
  if (category) {
    const cat = category.toLowerCase();
    tools = tools.filter((c) => {
      const node = getNode(c.id);
      if (!node) return false;
      if (node.type === "item") {
        const parent = listOfItem(node.id);
        return (
          (parent?.section ?? "").toLowerCase().includes(cat) ||
          (parent?.name ?? "").toLowerCase().includes(cat) ||
          (c.listName ?? "").toLowerCase().includes(cat)
        );
      }
      return (node.language ?? "").toLowerCase().includes(cat);
    });
  }
  return {
    category: category ?? null,
    tools: tools.slice(0, limit).map(cardToTool),
  };
}

function dispatchTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "search_best_tool":
      return searchBestTool(args);
    case "get_tool_details":
      return getToolDetails(args);
    case "compare_tools":
      return compareTools(args);
    case "find_awesome_section":
      return findAwesomeSection(args);
    case "get_trending_tools":
      return getTrendingTools(args);
    default:
      throw new McpError(-32602, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 handler (MCP Streamable HTTP: single request or batch)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "graphrag-app", version: "1.0.0" };
const INSTRUCTIONS =
  "Search the awesome-lists knowledge graph for the best tool for a task. " +
  "Use search_best_tool first for ranked, quality-checked recommendations " +
  "(rating 1-5 + freshness). Use get_tool_details for one tool, compare_tools " +
  "to compare 2-3, find_awesome_section to discover lists, get_trending_tools " +
  "for what is popular right now.";

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Handle one JSON-RPC request object. Returns a response object, or null
 *  for notifications (which get no response, per JSON-RPC 2.0). */
async function handleRpcRequest(req: unknown): Promise<Record<string, unknown> | null> {
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    return rpcError(null, -32600, "Invalid Request: expected a JSON-RPC object");
  }
  const r = req as Record<string, unknown>;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") {
    const id = typeof r.id === "string" || typeof r.id === "number" ? r.id : null;
    return rpcError(id, -32600, "Invalid Request");
  }
  const id: JsonRpcId =
    typeof r.id === "string" || typeof r.id === "number" ? r.id : null;
  const isNotification = r.id === undefined;
  const method = r.method as string;
  const params = r.params as Record<string, unknown> | undefined;

  try {
    switch (method) {
      case "initialize": {
        if (isNotification) return null;
        const clientVersion =
          params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = PROTOCOL_VERSIONS.includes(clientVersion)
          ? clientVersion
          : PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        // Notifications: no response, ever.
        return null;
      case "ping": {
        if (isNotification) return null;
        return rpcResult(id, {});
      }
      case "tools/list": {
        if (isNotification) return null;
        return rpcResult(id, { tools: MCP_TOOLS });
      }
      case "tools/call": {
        if (isNotification) return null;
        if (!params || typeof params.name !== "string" || !params.name) {
          return rpcError(id, -32602, "Invalid params: tools/call requires a 'name' string");
        }
        if (!MCP_TOOLS.some((t) => t.name === params.name)) {
          return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        }
        const args = params.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          return rpcError(id, -32602, "Invalid params: 'arguments' must be an object");
        }
        try {
          const payload = dispatchTool(params.name, args as Record<string, unknown>);
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          });
        } catch (e) {
          if (e instanceof McpToolFailure) {
            return rpcResult(id, {
              content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
              isError: true,
            });
          }
          if (e instanceof McpError) {
            return rpcError(id, e.code, e.message);
          }
          return rpcError(id, -32603, `Internal error: ${e instanceof Error ? e.message : "tool failed"}`);
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, -32603, `Internal error: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point (POST /mcp)
// ---------------------------------------------------------------------------

// Mirrors the CORS headers in src/index.ts (kept local to avoid a circular
// import: index.ts imports this module).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-resync-key",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function rpcResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/**
 * MCP Streamable HTTP endpoint. Accepts a single JSON-RPC request or a
 * batch (array). A request with no `id` is a notification and gets no
 * response (202, empty body). Malformed JSON -> -32700 Parse error.
 * Stateless: no Mcp-Session-Id is required or issued.
 */
export async function handleMcp(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "MCP endpoint accepts POST only (Streamable HTTP)" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcResponse(rpcError(null, -32700, "Parse error: invalid JSON"));
  }
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return rpcResponse(rpcError(null, -32600, "Invalid Request: empty batch"));
    }
    const responses: unknown[] = [];
    for (const item of body) {
      const res = await handleRpcRequest(item);
      if (res !== null) responses.push(res);
    }
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: { ...CORS_HEADERS } });
    }
    return rpcResponse(responses);
  }
  const res = await handleRpcRequest(body);
  if (res === null) {
    return new Response(null, { status: 202, headers: { ...CORS_HEADERS } });
  }
  return rpcResponse(res);
}
