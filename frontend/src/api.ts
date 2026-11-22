export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type GraphNode = {
  id: string;
  type: "repo" | "language" | "topic" | "contributor" | "package" | "item" | "list";
  name?: string;
  fullName?: string;
  description?: string;
  language?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  sizeKB?: number;
  archived?: boolean;
  isFork?: boolean;
  url?: string;
  homepage?: string;
  pushedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** v2 rating signal (1-5, "how much used in the current era"), computed at sync time. */
  rating?: number;
  /** v2 freshness signal, computed at sync time from last activity. */
  freshness?: "fresh" | "stale" | "outdated";
  /** v2 last activity (pushedAt date) of the node. */
  lastActivity?: string;
  /** Awesome section the node belongs to (e.g. "Programming Languages"). */
  section?: string;
};

export type GraphEdge = { source: string; target: string; type: string };
export type Subgraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type QueryEvents = {
  onSubgraph?: (label: string, sg: Subgraph) => void;
  onChunk?: (chunk: string) => void;
  onDone?: (answer: string) => void;
  onError?: (message: string) => void;
};

export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function fetchHealth(): Promise<{ ok: boolean; meta?: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export async function fetchExpand(id: string): Promise<Subgraph> {
  const res = await fetch(`${API_BASE}/api/expand?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`expand failed: ${res.status}`);
  const data = await res.json();
  return data.subgraph;
}

/** v2 ranked answer card returned by POST /api/answer and GET /api/trending. */
export type AnswerCard = {
  rank: number;
  id: string;
  type: string;
  name: string;
  fullName?: string;
  url?: string;
  description?: string;
  stars?: number;
  forks?: number;
  language?: string;
  lastActivity?: string;
  rating: number;
  freshness: "fresh" | "stale" | "outdated";
  why: string;
  listName?: string;
  section?: string;
};

/** v2 category from GET /api/categories (list sections/topics with live counts). */
export type Category = {
  name: string;
  listCount: number;
  itemCount: number;
};

/** No-key ranked search: POST /api/answer. Works with no LLM key at all. */
export async function answer(question: string, limit = 8): Promise<{ label: string; cards: AnswerCard[] }> {
  const res = await fetch(`${API_BASE}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, limit }),
  });
  if (!res.ok) {
    let msg = `answer failed: ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

/** Trending tools (top items by stars + recent activity): GET /api/trending. */
export async function fetchTrending(): Promise<{ items: AnswerCard[] }> {
  const res = await fetch(`${API_BASE}/api/trending`);
  if (!res.ok) throw new Error(`trending failed: ${res.status}`);
  return res.json();
}

/** Category filter bar data: GET /api/categories. */
export async function fetchCategories(): Promise<{ categories: Category[] }> {
  const res = await fetch(`${API_BASE}/api/categories`);
  if (!res.ok) throw new Error(`categories failed: ${res.status}`);
  return res.json();
}

/**
 * Optional Workers AI short answer: POST /api/answer-llm.
 * Returns null on 501 (AI binding not configured) so the UI falls back silently.
 */
export async function answerLlm(
  question: string,
): Promise<{ answer: string; source: "ai" | "template"; cards?: AnswerCard[] } | null> {
  const res = await fetch(`${API_BASE}/api/answer-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (res.status === 501) return null;
  if (!res.ok) throw new Error(`answer-llm failed: ${res.status}`);
  return res.json();
}

/** POST /api/query and parse the SSE stream. Resolves with the final answer text. */
export async function ask(question: string, provider: ProviderConfig, handlers: QueryEvents, history: { role: string; content: string }[] = []): Promise<string> {
  const res = await fetch(`${API_BASE}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, provider, history }),
  });

  if (!res.ok || !res.body) {
    let msg = `query failed: ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch { /* ignore */ }
    handlers.onError?.(msg);
    return "";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let finalAnswer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const payload = JSON.parse(data);
          if (event === "subgraph") handlers.onSubgraph?.(payload.label ?? "", payload.subgraph);
          else if (event === "answer") handlers.onChunk?.(payload.chunk ?? "");
          else if (event === "done") {
            finalAnswer = payload.answer ?? "";
            handlers.onDone?.(finalAnswer);
          } else if (event === "error") handlers.onError?.(payload.error ?? "LLM error");
        } catch { /* skip malformed */ }
        event = "";
      }
    }
  }
  return finalAnswer;
}

export const DEFAULT_PROVIDER: ProviderConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

const LS_KEY = "graphrag.provider";

export function loadProvider(): ProviderConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_PROVIDER, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PROVIDER };
}

export function saveProvider(p: ProviderConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}
