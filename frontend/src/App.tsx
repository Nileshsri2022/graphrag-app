import { useCallback, useEffect, useRef, useState } from "react";
import GraphView from "./GraphView";
import {
  API_BASE,
  ask,
  fetchHealth,
  loadProvider,
  saveProvider,
  type ProviderConfig,
  type Subgraph,
} from "./api";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: { name: string; url: string }[];
  error?: boolean;
};

type Health = { ok: boolean; meta?: Record<string, unknown> };

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderConfig>(loadProvider);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [subgraph, setSubgraph] = useState<Subgraph | null>(null);
  const [graphLabel, setGraphLabel] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [resyncKey, setResyncKey] = useState<string>(() => localStorage.getItem("graphrag.resyncKey") ?? "");
  const answerRef = useRef<Message | null>(null);
  const historyRef = useRef<{ role: string; content: string }[]>([]);

  const startNewChat = useCallback(() => {
    historyRef.current = [];
    answerRef.current = null;
    setMessages([]);
    setSubgraph(null);
    setGraphLabel("");
  }, []);

  const resync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch(`${API_BASE}/api/resync`, {
        method: "POST",
        headers: resyncKey ? { "x-resync-key": resyncKey } : {},
      });
      const data = await res.json();
      setSyncMsg(data.message ?? (res.ok ? "Sync requested" : `Sync failed (${res.status})`));
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [resyncKey]);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
  }, []);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || busy) return;
    if (!provider.apiKey) {
      setSettingsOpen(true);
      return;
    }
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: question }]);
    setMessages((m) => [...m, { role: "assistant", content: "" }]);
    answerRef.current = null;
    const hist = historyRef.current;

    const finalAnswer = await ask(
      question,
      provider,
      {
      onSubgraph: (label, sg) => {
        setGraphLabel(label);
        setSubgraph(sg);
        const sources = sg.nodes
          .filter((n) => n.type === "repo" && n.url)
          .slice(0, 12)
          .map((n) => ({ name: n.fullName ?? n.id, url: n.url! }));
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, sources };
          return copy;
        });
      },
      onChunk: (chunk) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + chunk };
          }
          return copy;
        });
      },
      onDone: (answer) => {
        answerRef.current = { role: "assistant", content: answer };
      },
      onError: (err) => {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: err, error: true };
          return copy;
        });
      },
    },
    hist,
  );

    // push finished turns into conversation history
    historyRef.current = [...hist, { role: "user", content: question }, { role: "assistant", content: finalAnswer }].slice(-12);
    setBusy(false);
  }, [input, busy, provider]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-glyph">◆</span>
          Graph<span className="g">RAG</span>
        </div>
        <div className="header-spacer" />
        <div className="model-badge" title={provider.model}>
          {provider.model || "no model configured"}
        </div>
        <button className="btn" onClick={() => setSettingsOpen(true)}>⚙ Settings</button>
        <button className="btn" onClick={startNewChat} disabled={busy} title="Clear conversation">+ New chat</button>
      </header>

      <div className="main">
        <section className="chat-panel">
          <div className="messages">
            {messages.length === 0 && (
              <div className="chat-empty">
                <div className="chat-empty-orb">◆</div>
                <h2>Ask anything about 1,148 repos</h2>
                <p>Query the sindresorhus knowledge graph — answers stream in, and the retrieved subgraph renders live.</p>
                <div className="example-chips">
                  {["which repos depend on execa?", "top Swift repos by stars", "repos about terminals"].map((ex) => (
                    <button key={ex} className="example-chip" onClick={() => setInput(ex)}>
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}${m.error ? " error" : ""}`}>
                {m.role === "assistant" && <span className="label">GraphRAG</span>}
                {m.content}
                {busy && i === messages.length - 1 && !m.content && <span className="cursor" />}
                {m.role === "assistant" && !busy && i === messages.length - 1 && !m.error && answerRef.current && <span className="cursor" />}
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <div className="sources">
                    {m.sources.map((s, j) => (
                      <a key={j} className="src-chip" href={s.url} target="_blank" rel="noreferrer">
                        {s.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="composer">
            <div className="composer-shell">
              <textarea
                value={input}
                placeholder="Type your question…"
                aria-label="Your question"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button className="btn primary btn-send" onClick={send} disabled={busy || !input.trim()}>
                {busy ? <span className="spinner" /> : "Ask ▸"}
              </button>
            </div>
            <div className="composer-hint">Enter ↵ to send · Shift+Enter for a new line</div>
          </div>
          {!provider.apiKey && (
            <div className="setup-card">
              <div className="setup-icon">🔑</div>
              <div className="setup-text">
                <strong>Connect your LLM provider</strong>
                <span>Set base URL, API key & model to start asking questions.</span>
              </div>
              <button className="btn primary" onClick={() => setSettingsOpen(true)}>
                Configure ▸
              </button>
            </div>
          )}
        </section>

        <GraphView subgraph={subgraph} label={graphLabel} />
      </div>

      <footer className="statusbar">
        <span>
          <span className={`dot ${health?.ok ? "ok" : health ? "err" : "wait"}`} />
          API: {health?.ok ? "online" : health ? "offline" : "checking…"} ({API_BASE || "same origin"})
        </span>
        <span>
          <span className="dot ok" /> {(health?.meta?.repoCount ?? 1148).toLocaleString()} repos indexed
        </span>
        <span className="status-right">
          {syncMsg && <span className="sync-msg">{syncMsg}</span>}
          <button className="btn" onClick={resync} disabled={syncing}>
            {syncing ? <><span className="spinner" /> Syncing…</> : "↻ Re-sync"}
          </button>
        </span>
      </footer>

      {settingsOpen && (
        <div className="overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 id="settings-title">LLM Provider</h3>
              <button className="btn icon-btn ghost" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Base URL · OpenAI-compatible</label>
                <input
                  value={provider.baseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setProvider({ ...provider, baseUrl: e.target.value })}
                />
                <div className="preset-row">
                  {[
                    { label: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
                    { label: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" },
                    { label: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
                    { label: "Ollama", url: "http://localhost:11434/v1", model: "llama3.1" },
                  ].map((p) => (
                    <button
                      key={p.label}
                      className="preset-chip"
                      onClick={() => setProvider({ ...provider, baseUrl: p.url, model: p.model })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>API key</label>
                <input
                  type="password"
                  value={provider.apiKey}
                  placeholder="sk-…"
                  autoComplete="off"
                  onChange={(e) => setProvider({ ...provider, apiKey: e.target.value })}
                />
                <div className="hint">Stored only in this browser (localStorage). Sent to the Worker which proxies the call — never shipped in the static bundle.</div>
              </div>
              <div className="field">
                <label>Model</label>
                <input
                  value={provider.model}
                  placeholder="gpt-4o-mini / llama-3.1-8b-instant / gemini-2.0-flash"
                  onChange={(e) => setProvider({ ...provider, model: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Re-sync key (optional)</label>
                <input
                  type="password"
                  value={resyncKey}
                  placeholder="for the Re-sync button"
                  onChange={(e) => {
                    setResyncKey(e.target.value);
                    localStorage.setItem("graphrag.resyncKey", e.target.value);
                  }}
                />
                <div className="hint">Same value as the worker's RESYNC_KEY secret. Only needed if you want the Re-sync button to trigger a data refresh.</div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setSettingsOpen(false)}>Cancel</button>
              <button
                className="btn primary"
                onClick={() => {
                  saveProvider(provider);
                  setSettingsOpen(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
