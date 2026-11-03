# GraphRAG — sindresorhus repos

Zero-cost GraphRAG app over the ~1,148 GitHub repos of [sindresorhus](https://github.com/sindresorhus).
Ask questions in natural language; the backend retrieves only the *relevant subgraph* and a configured
LLM answers with real repo context. Subgraph shown in an interactive graph view.

## Architecture

```
GitHub API/xlsx ──▶ scripts/sync_data.py ──▶ data/graph.json (snapshot)
                                                      │
                                                      ▼
SPA (GitHub Pages) ──▶ Cloudflare Worker ──▶ in-memory graph + template retrieval
                          │                            │
                          └──── OpenAI-compatible LLM (baseUrl + key + model from UI)
```

- **Data layer:** `.venv` (uv) + openpyxl — exports the xlsx snapshot to an embedded JSON graph.
- **Backend:** Cloudflare Worker (TypeScript). Endpoints:
  - `GET /api/health` — status + meta
  - `POST /api/query` — SSE stream: `subgraph` event → answer chunks → `done`
  - `GET /api/expand?id=<node>` — neighborhood expansion for click-to-expand
- **Frontend:** Vite + React + Cytoscape (chat panel + interactive graph). Provider (base URL,
  API key, model) configured in the UI and stored in localStorage only.

## Local development

```bash
# 1. data snapshot (already generated)
cd scripts && uv venv .venv && uv pip install --python .venv/Scripts/python.exe openpyxl
.venv/Scripts/python.exe sync_data.py

> Sync note: `sync_data.py` requires the source spreadsheet at `reports/sindresorhus_repos.xlsx`
> (not committed — export it from GitHub). It writes `data/graph.json`. The Worker loads its own
> bundled copy at `worker/data/graph.json`; after re-running sync, copy it over before deploying:
> `cp data/graph.json ../worker/data/graph.json`

# 2. backend (worker) — requires Node 18+
cd ../worker && npm install
npx wrangler dev --port 8787

# 3. frontend
cd ../frontend && npm install && npm run dev
# open http://localhost:5173 — dev server proxies /api to the worker
```

For local E2E with a mock LLM (no key needed):

```bash
# terminal A
cd ../scripts && .venv/Scripts/python.exe mock_llm.py        # mock OpenAI-compatible on :9999
# terminal B (restart worker with local LLM allowed — dev only)
cd ../worker && npx wrangler dev --port 8787 --var ALLOW_LOCAL_LLM:1
# SPA Settings → Base URL http://127.0.0.1:9999/v1, key anything, model anything
```

## Deploy (zero cost)

### 1. Cloudflare Worker

```bash
cd worker
npx wrangler login            # browser sign-in (free Cloudflare account)
npx wrangler deploy           # prints https://graphrag-app.<subdomain>.workers.dev
# optional: server-side default key (per-request UI key also works)
npx wrangler secret put LLM_API_KEY
```

### 2. SPA → GitHub Pages

Set repo action **variable** `VITE_API_BASE` (repo → Settings → Secrets and variables → Actions → Variables) to your
worker URL, e.g. `https://graphrag-app.<subdomain>.workers.dev`. (The workflow reads it via
`vars.VITE_API_BASE` — it is a public build-time value, not a secret.) Push to `main`; the
`.github/workflows/deploy-pages.yml` workflow builds and publishes `frontend/dist` to Pages.
Note the workflow triggers only on `frontend/**` changes or manual dispatch — worker-only changes do not rebuild the SPA.

## Security notes (from the Security checklist)

- Webhook surface not used in v1 (polling via sync script) — no signature verification needed yet.
- LLM base URL is SSRF-guarded: https-only + no loopback/private/metadata hosts (`ALLOW_LOCAL_LLM`
  escapes this for local dev only).
- API keys never ship in the static bundle — they live in localStorage and go to the Worker, which
  proxies the LLM call.
- Rate limit: 30 req/min per IP (in-memory).
- Cypher/query injection is moot — retrieval uses fixed template queries over an allowed graph.

## Trust boundary & operations

**Trust boundary:** everything served by GitHub Pages is public static content — assume it is fully
inspectable. The Cloudflare Worker API is the only trusted boundary: it validates input, guards the
LLM endpoint, enforces rate limits and a daily LLM budget, and proxies LLM calls so no provider API
key ships in the bundle (keys live in browser localStorage only).

**Runbook (quick):**

- *LLM key rotation* — user updates it in the SPA Settings (localStorage), or you replace the
  optional `LLM_API_KEY` secret (`npx wrangler secret put LLM_API_KEY`) for the server-side default.
- *Abuse / rate-limit hits* — the limiter is 30 req/min per IP; the global LLM budget defaults to
  200 calls/day (`LLM_DAILY_REQUEST_CAP` env var). The 30/min limiter is in-memory per Worker
  instance, so it weakens under multi-instance scaling — deploy in one region or move counters to KV.
- *Rollback* — the worker is stateless; redeploy the previous commit (`git revert` + `wrangler deploy`).
  The SPA is only the last deployed `dist/` on Pages.
- *Data refresh* — rerun `scripts/sync_data.py` to regenerate `data/graph.json`, copy it into
  `worker/data/graph.json`, rebuild, redeploy.

## Intent → query templates (hand-written, per the Karpathy review)

| Example question | Retrieval |
|---|---|
| `top typescript repos` | language filter, sorted by stars |
| `repos about electron` | topic keyword match → subgraph |
| `most forks` | `isFork` filter, sorted by forks (note: “most forked” filters forks but sorts by stars) |
| `archived repos` | `archived` filter |
| `all repos` / `top repos` | all repos sorted by stars |

## Project layout

```
graphrag-app/
├─ scripts/            sync_data.py · mock_llm.py · .venv/
├─ data/               graph.json (generated snapshot)
├─ worker/             Cloudflare Worker (TypeScript)
├─ frontend/           Vite + React + Cytoscape SPA
└─ .github/workflows/  GitHub Pages deploy
```
