import { useCallback, useEffect, useRef, useState } from "react";
import GraphView from "./GraphView";
import AnswerCards from "./AnswerCards";
import ResultCards from "./ResultCards";
import {
  API_BASE,
  answer,
  ask,
  fetchCategories,
  fetchExpand,
  fetchHealth,
  fetchTrending,
  loadProvider,
  saveProvider,
  type AnswerCard,
  type Category,
  type GraphNode,
  type ProviderConfig,
  type Subgraph,
} from "./api";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: GraphNode[];
  error?: boolean;
};

type Health = { ok: boolean; meta?: Record<string, unknown> };

const USE_CASE_CHIPS = [
  "I want to build a website",
  "Best Python testing tool",
  "Lightweight static site generator",
  "Compare two tools",
];

export default function App() {
  // No-key search state (the default path — no LLM key required)
  const [input, setInput] = useState("");
  const [cards, setCards] = useState<AnswerCard[]>([]);
  const [answerLabel, setAnswerLabel] = useState("");
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Guided discovery
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [trending, setTrending] = useState<AnswerCard[]>([]);

  // Health / footer
  const [health, setHealth] = useState<Health | null>(null);

  // Graph (secondary — hidden by default)
  const [subgraph, setSubgraph] = useState<Subgraph | null>(null);
  const [graphLabel, setGraphLabel] = useState("");
  const [showGraph, setShowGraph] = useState(false);

  // Optional BYOK LLM chat (secondary panel, never a gate)
  const [llmOpen, setLlmOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [llmInput, setLlmInput] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);

  // Settings / sync (kept as today)
  const [provider, setProvider] = useState<ProviderConfig>(loadProvider);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [resyncKey, setResyncKey] = useState<string>(() => localStorage.getItem("graphrag.resyncKey") ?? "");

  const heroInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<Message | null>(null);
  const historyRef = useRef<{ role: string; content: string }[]>([]);

  // Ctrl-K focuses the search input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        heroInputRef.current?.focus();
        heroInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Health, categories and trending load best-effort — the page works without them.
  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
    fetchCategories()
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => setCategories([]));
    fetchTrending()
      .then((d) => setTrending(d.items ?? []))
      .catch(() => setTrending([]));
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const question = q.trim();
    if (!question) return;
    setSearching(true);
    setSearchError(null);
    setSearched(true);
    setShowGraph(false);
    setActiveCategory(null);
    try {
      const res = await answer(question);
      const found = res.cards ?? [];
      setCards(found);
      setAnswerLabel(res.label ?? question);
      // Best-effort subgraph for the "Explore graph" toggle.
      const first = found[0];
      if (first?.id) {
        try {
          const sg = await fetchExpand(first.id);
          setSubgraph(sg);
          setGraphLabel(
            /compare/i.test(question) && found.length >= 2
              ? `compare:${found[0].name}|${found[1].name}`
              : `subgraph: ${first.name}`,
          );
        } catch {
          setSubgraph(null);
          setGraphLabel("");
        }
      } else {
        setSubgraph(null);
        setGraphLabel("");
      }
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setCards([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // Category filter: filter the shown cards by listName/section; if there are
  // no cards yet (no search run), re-query with the category name instead.
  const visibleCards = activeCategory
    ? cards.filter((c) => c.listName === activeCategory || c.section === activeCategory)
    : cards;
  const categoryFilteredEmpty = activeCategory !== null && cards.length > 0 && visibleCards.length === 0;
  const shownCards = categoryFilteredEmpty ? cards : visibleCards;

  const onCategory = (name: string | null) => {
    if (name === null) {
      setActiveCategory(null);
      return;
    }
    setActiveCategory(name);
    if (cards.length === 0) void runSearch(name);
  };

  const sendLlm = useCallback(async () => {
    const question = llmInput.trim();
    if (!question || llmBusy) return;
    setLlmInput("");
    setLlmBusy(true);
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
          const sources = sg.nodes.filter((n) => n.type === "repo" && n.url);
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
        onDone: (ans) => {
          answerRef.current = { role: "assistant", content: ans };
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

    historyRef.current = [...hist, { role: "user", content: question }, { role: "assistant", content: finalAnswer }].slice(-12);
    setLlmBusy(false);
  }, [llmInput, llmBusy, provider]);

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

  // ---- Footer meta ----
  const meta = health?.meta ?? {};
  const metaNum = (k: string): number | null => (typeof meta[k] === "number" ? (meta[k] as number) : null);
  const generatedAt = typeof meta.generatedAt === "string" ? meta.generatedAt : null;
  const generatedDate = generatedAt ? new Date(generatedAt) : null;
  const generatedValid = generatedDate !== null && !Number.isNaN(generatedDate.getTime());
  const staleData = generatedValid
    ? Date.now() - (generatedDate as Date).getTime() > 7 * 24 * 60 * 60 * 1000
    : false;
  const repoCount = metaNum("repoCount") ?? metaNum("nodeCount");
  const itemCount = metaNum("itemCount");
  const listCount = metaNum("listCount");

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-glyph">⬡</span>
          <span>Awesome Graph</span>
          <span className="brand-sub">Knowledge engine</span>
        </div>
        <div className="header-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch(input);
              }
            }}
            placeholder="Search tools…"
            aria-label="Search tools"
          />
          <kbd>Ctrl K</kbd>
        </div>
        <span className="nokey-badge">
          <span className="pulse-dot" />
          No key needed
        </span>
        <button className="btn" onClick={() => setSettingsOpen(true)}>
          ⚙ Settings
        </button>
      </header>

      <main className="page">
        <section className="hero">
          <div className="status-pill">
            <span className="pulse-dot" />
            Natural language graph query · Live sync
          </div>
          <h1>
            Find the best tool. <em>Skip the list.</em>
          </h1>
          <p className="hero-sub">
            Search the awesome lists without browsing them — ranked tools, freshness ratings, no key needed.
          </p>
          <form
            className="search-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(input);
            }}
          >
            <span className="search-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              ref={heroInputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask: best tool for…"
              aria-label="Ask for the best tool"
            />
            <kbd className="search-kbd">Ctrl K</kbd>
            <button className="btn primary search-btn" type="submit" disabled={searching}>
              {searching ? "Searching…" : "Search →"}
            </button>
          </form>
          <div className="chips">
            <span className="chips-label">Quick search:</span>
            {USE_CASE_CHIPS.map((c) => (
              <button
                key={c}
                className="chip"
                onClick={() => {
                  setInput(c);
                  void runSearch(c);
                }}
              >
                “{c}”
              </button>
            ))}
          </div>
        </section>

        {categories.length > 0 && (
          <section className="cat-bar" aria-label="Filter by category">
            <div className="cat-chips">
              <button
                className={`cat-chip${activeCategory === null ? " active" : ""}`}
                onClick={() => onCategory(null)}
              >
                All
              </button>
              {categories.map((c) => (
                <button
                  key={c.name}
                  className={`cat-chip${activeCategory === c.name ? " active" : ""}`}
                  onClick={() => onCategory(c.name)}
                >
                  {c.name}
                  <span className="cat-count">{c.itemCount.toLocaleString()}</span>
                </button>
              ))}
            </div>
            <div className="sort-note">
              Ranked by <strong>rating</strong> · GitHub stars · recency
            </div>
          </section>
        )}

        <div ref={resultsRef} className="results">
          {searching && (
            <div className="loading">
              <span className="spinner" /> Searching the graph…
            </div>
          )}

          {!searching && searchError && (
            <div className="error-box" role="alert">
              Search failed: {searchError}
            </div>
          )}

          {!searching && !searchError && searched && (
            <>
              <div className="results-head">
                <h2>{answerLabel ? `Results for ${answerLabel}` : "Results"}</h2>
                <span className="results-count">
                  {shownCards.length} {shownCards.length === 1 ? "tool" : "tools"}
                </span>
                {subgraph && (
                  <button className="btn" onClick={() => setShowGraph((v) => !v)} aria-expanded={showGraph}>
                    {showGraph ? "Hide graph" : "Explore graph"}
                  </button>
                )}
              </div>
              {categoryFilteredEmpty && (
                <p className="filter-note">
                  No matches in “{activeCategory}” for this query — showing all results.
                </p>
              )}
              {shownCards.length === 0 ? (
                <div className="empty-state">
                  <p>No tools found. Try a different query — e.g. “Best Python testing tool”.</p>
                </div>
              ) : (
                <AnswerCards cards={shownCards} />
              )}
              {showGraph && subgraph && (
                <section className="graph-section" aria-label="Explore graph">
                  <GraphView subgraph={subgraph} label={graphLabel} />
                </section>
              )}
            </>
          )}

          {!searched && !searching && !searchError && trending.length > 0 && (
            <section className="trending">
              <h2>Trending</h2>
              <p className="section-sub">Most-starred, recently active tools in the graph.</p>
              <AnswerCards cards={trending} />
            </section>
          )}

          {!searched && !searching && !searchError && trending.length === 0 && (
            <div className="empty-state">
              <p>Search above to find the best tool — no key needed.</p>
            </div>
          )}
        </div>

        <section className="llm-panel">
          <button className="llm-toggle" onClick={() => setLlmOpen((v) => !v)} aria-expanded={llmOpen}>
            <span>
              Ask the LLM{" "}
              {provider.apiKey ? <span className="llm-toggle-sub">· key configured</span> : <span className="llm-toggle-sub">· optional, needs a key</span>}
            </span>
            <span aria-hidden="true">{llmOpen ? "▲" : "▼"}</span>
          </button>
          {llmOpen && !provider.apiKey && (
            <p className="llm-note">
              The ranked answers above need no key. To also chat with an LLM, add a provider key in Settings —
              the chat is an optional extra, never a requirement.
            </p>
          )}
          {llmOpen && provider.apiKey && (
            <>
              <div className="messages">
                {messages.length === 0 && (
                  <p className="llm-note">Ask a follow-up and the LLM will answer with the graph as context.</p>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`msg ${m.role}${m.error ? " error" : ""}`}>
                    {m.role === "assistant" && <span className="label">Awesome Graph</span>}
                    {m.content}
                    {llmBusy && i === messages.length - 1 && !m.content && <span className="cursor" />}
                    {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                      <ResultCards repos={m.sources} />
                    )}
                  </div>
                ))}
              </div>
              <div className="llm-composer">
                <input
                  value={llmInput}
                  onChange={(e) => setLlmInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void sendLlm();
                    }
                  }}
                  placeholder="Ask the LLM a follow-up…"
                  aria-label="Ask the LLM a follow-up"
                />
                <button className="btn primary" onClick={() => void sendLlm()} disabled={llmBusy || !llmInput.trim()}>
                  {llmBusy ? <span className="spinner" /> : "Ask ▸"}
                </button>
              </div>
            </>
          )}
        </section>
      </main>

      <footer className="statusbar">
        <span className="status-item">
          <span className={`dot ${health?.ok ? "ok" : health ? "err" : "wait"}`} />
          API: {health?.ok ? "online" : health ? "offline" : "checking…"} ({API_BASE || "same origin"})
        </span>
        {repoCount !== null && <span className="status-item">{repoCount.toLocaleString()} repos</span>}
        {itemCount !== null && <span className="status-item">{itemCount.toLocaleString()} items</span>}
        {listCount !== null && <span className="status-item">{listCount.toLocaleString()} lists</span>}
        <span className="status-item">
          Data as of {generatedValid ? (generatedDate as Date).toLocaleDateString() : "—"}
        </span>
        {staleData && <span className="stale-note">Data may be stale — snapshot is over 7 days old.</span>}
        <span className="status-right">
          {syncMsg && <span className="sync-msg">{syncMsg}</span>}
          <button className="btn" onClick={resync} disabled={syncing}>
            {syncing ? (
              <>
                <span className="spinner" /> Syncing…
              </>
            ) : (
              "↻ Re-sync"
            )}
          </button>
        </span>
      </footer>

      {settingsOpen && (
        <div className="overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 id="settings-title">LLM Provider</h3>
              <button className="btn icon-btn ghost" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
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
                <div className="hint">Stored only in this browser (localStorage). Sent to the Worker which proxies the call — never shipped in the static bundle. Optional: the ranked search above works without it.</div>
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
              <button className="btn" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
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
