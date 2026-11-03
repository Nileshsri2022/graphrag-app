export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type GraphNode = {
  id: string;
  type: "repo" | "language" | "topic";
  name?: string;
  fullName?: string;
  description?: string;
  language?: string;
  stars?: number;
  forks?: number;
  archived?: boolean;
  isFork?: boolean;
  url?: string;
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

/** POST /api/query and parse the SSE stream. */
export async function ask(question: string, provider: ProviderConfig, handlers: QueryEvents): Promise<void> {
  const res = await fetch(`${API_BASE}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, provider }),
  });

  if (!res.ok || !res.body) {
    let msg = `query failed: ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch { /* ignore */ }
    handlers.onError?.(msg);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";

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
          else if (event === "done") handlers.onDone?.(payload.answer ?? "");
          else if (event === "error") handlers.onError?.(payload.error ?? "LLM error");
        } catch { /* skip malformed */ }
        event = "";
      }
    }
  }
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
