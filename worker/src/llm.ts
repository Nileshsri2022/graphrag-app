// OpenAI-compatible chat completions call. Provider (baseUrl / key / model)
// can come from the request (SPA settings) or from env defaults.

export type LLMConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** For item-intent retrievals, pin the item -> listing-repo fact in the prompt
 *  so answers phrase it as "X is listed inside Y". Returns "" otherwise. */
export function itemPromptLine(label: string): string {
  const m = label.match(/^“(.+)” is listed in (.+)$/);
  if (!m) return "";
  return (
    `The question is about a list item named “${m[1]}”, which is listed in: ${m[2]}. ` +
    `Say it is "listed inside" the repo (e.g. “${m[1]} is listed inside …”).`
  );
}

export function defaultConfig(env: Record<string, string | undefined>): LLMConfig {
  return {
    baseUrl: env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL ?? "gpt-4o-mini",
  };
}

/** Known OpenAI-compatible provider hosts (BYOK allowlist). */
const ALLOWED_LLM_HOSTS = new Set([
  "api.openai.com",
  "api.openrouter.ai",
  "api.groq.com",
  "generativelanguage.googleapis.com",
  "api.together.xyz",
  "api.mistral.ai",
  "api.deepseek.com",
  "api.x.ai",
  "api.anthropic.com",
  "api.moonshot.cn",
  "openrouter.ai",
  "api.inceptionlabs.ai",
]);

/** BYOK baseUrl is pinned to known providers unless explicitly widened. */
export function isAllowedProviderHost(url: string): boolean {
  try {
    return ALLOWED_LLM_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Very light SSRF guard: https only, no loopback/private/metadata hosts.
 *  `allowLocal` is dev-only (mock LLM testing) and never enabled in prod. */
export function validateBaseUrl(url: string, allowLocal = false): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && !(allowLocal && u.protocol === "http:")) return false;
  const host = u.hostname.toLowerCase();
  if (allowLocal) return true; // dev-only: skip host checks (mock LLM on loopback)
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".")) return false; // trailing-dot DNS tricks
  if (host.endsWith(".nip.io") || host.endsWith(".sslip.io") || host.endsWith(".xip.io")) return false;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^::1$|^fe80:/.test(host)) return false;
  // 172.16.0.0/12
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  // all-decimal / IPv4-style hostnames (e.g. 2130706433)
  if (/^\d+(\.\d+)*$/.test(host)) return false;
  if (host === "169.254.169.254") return false; // cloud metadata
  return true;
}

export async function chat(config: LLMConfig, messages: { role: string; content: string }[], onChunk?: (text: string) => void): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000), // don't hang an SSE connection on a dead upstream
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("LLM: no response body");

  let full = "";
  const decoder = new TextDecoder();

  // Parse SSE lines from the stream.
  const reader = res.body.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          onChunk?.(delta);
        }
      } catch {
        // ignore partial JSON lines
      }
    }
  }
  return full;
}
