// GraphRAG Worker — zero-cost backend.
//
// Endpoints:
//   GET  /api/health          -> { ok, meta }
//   POST /api/query           -> SSE stream: subgraph event, answer chunks, done
//   GET  /api/expand?id=<node> -> { nodes, edges } neighborhood (click-to-expand)

import { meta } from "./graph";
import { expand, formatSources, retrieve } from "./retrieval";
import { chat, defaultConfig, validateBaseUrl, type LLMConfig } from "./llm";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---- minimal in-memory rate limit (per-IP) ----
const WINDOW_MS = 60_000;
const MAX_REQ_PER_IP = 30;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.set(ip, arr);
  if (arr.length >= MAX_REQ_PER_IP) return true;
  arr.push(now);
  return false;
}

function corsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function sse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

function buildPrompt(question: string, label: string, sourcesCtx: string): { role: string; content: string }[] {
  const system = [
    "You are a helpful assistant for a knowledge graph of GitHub repositories by sindresorhus.",
    "Answer the user's question using ONLY the repositories listed below.",
    "Never invent repositories that are not in the list.",
    "Be concise. When you name a repo, use its full name (owner/repo).",
    "Relevant repositories:",
    sourcesCtx,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `Retrieval note: ${label}. Question: ${question}` },
  ];
}

async function handleQuery(request: Request, env: Record<string, string | undefined>): Promise<Response> {
  let body: { question?: string; provider?: Partial<LLMConfig> };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const question = (body.question ?? "").trim();
  if (!question || question.length > 500) {
    return json({ error: "question is required (max 500 chars)" }, 400);
  }

  const cfg = { ...defaultConfig(env), ...(body.provider ?? {}) };
  // Dev-only escape hatch for testing against a mock LLM; never set in production.
  const allowLocal = Boolean(env.ALLOW_LOCAL_LLM) && env.ALLOW_LOCAL_LLM !== "0";
  if (!validateBaseUrl(cfg.baseUrl, allowLocal)) {
    return json({ error: "invalid LLM base URL (https, public host required)" }, 400);
  }
  if (!cfg.apiKey) {
    return json({ error: "missing LLM API key" }, 400);
  }
  if (!cfg.model) {
    return json({ error: "missing LLM model" }, 400);
  }

  const retrieval = retrieve(question);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        send("subgraph", { label: retrieval.label, subgraph: retrieval.subgraph });
        const messages = buildPrompt(question, retrieval.label, formatSources(retrieval.sources));
        const answer = await chat(cfg, messages, (chunk) => send("answer", { chunk }));
        send("done", { answer });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "LLM call failed" });
      } finally {
        controller.close();
      }
    },
  });

  return sse(stream);
}

function handleExpand(request: Request): Response {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  const subgraph = expand(id, 30);
  return json({ subgraph });
}

export default {
  async fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (rateLimited(ip)) {
      return json({ error: "rate limit exceeded — try again in a minute" }, 429);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, meta });
    }
    if (url.pathname === "/api/query" && request.method === "POST") {
      return handleQuery(request, env);
    }
    if (url.pathname === "/api/expand" && request.method === "GET") {
      return handleExpand(request);
    }
    return json({ error: "not found" }, 404);
  },
};
