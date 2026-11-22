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

## Data pipeline (v2): awesome knowledge base

The knowledge base is the [awesome](https://github.com/Nileshsri2022/awesome)
README — 675 list entries in 28 sections — plus the items *inside* each list.
`scripts/sync_data_v2.py` builds the base graph (sindresorhus repos,
topics, deps, contributors) when the `reports/sindresorhus_repos.xlsx`
snapshot is present (maintainer's machine only — it is not committed, so in
CI that step skips and the base is the checked-in `worker/data/graph.json`);
`scripts/sync_awesome.py` then merges the awesome layer on top of it. The full sync runs in GitHub Actions
(`.github/workflows/sync.yml`, daily 04:00 UTC) with `GITHUB_TOKEN`; nothing
in the pipeline needs a paid service.

### Running the awesome sync

```bash
cd scripts
# Sample run (no token needed for a handful of lists; unauthenticated
# GitHub REST = 60 req/hr — do NOT loop-retry on 429, the script stops
# fetching and builds from what it has):
python3 sync_awesome.py --max-lists 5
# → writes scripts/sample-output/sample-graph.json (never touches the
#   real data/graph.json)

# Target one list (e.g. to check a known item):
python3 sync_awesome.py --only-list vinta/awesome-python --max-lists 1

# Full run (writes <repo>/data/graph.json; needs GITHUB_TOKEN):
GITHUB_TOKEN=... python3 sync_awesome.py --full
# By default the awesome README is read from ~/workspace/awesome-readme.md;
# pass --readme PATH to use another copy (Actions downloads it via the API).
```

Cache & resume: fetched list READMEs + repo metadata are cached in
`scripts/.awesome_cache.json` (keyed by repo `fullName`, git-ignored; in
Actions it is persisted with `actions/cache`). Reruns only fetch what is
missing; cached entries older than 7 days are refetched. On HTTP 429 the
script stops fetching immediately, keeps the cache, builds the graph from
fetched data, records the rest in `meta.skippedLists`, and exits 0. A list
whose README cannot be fetched is skipped the same way — the sync never
fails as a whole because of one list. Hard caps: nodes < 50,000,
edges < 100,000.

### Freshness + rating (1–5, computed at sync time)

Every list repo and every item that links to a GitHub repo gets a `rating`
(1–5), a `freshness` (`fresh` | `stale` | `outdated`), and a
`lastActivity` date (pushedAt, else updatedAt) on its node. The rubric —
"how much used in the current era" — is implemented in
`scripts/rating.py` (`rate_repo()`) and mirrored in the worker's TypeScript
(the two must agree):

| Rating | Meaning |
|---|---|
| 5 | Active < 6 months **and** ≥ 1,000 stars — widely used. Stars alone never give 5; activity is required. |
| 4 | Active < 1 year, strong adoption (< 6 mo but < 1,000 stars also lands here). |
| 3 | Niche but alive / declining — activity 1–2 years. |
| 2 | 2–4 years no activity, superseded; also the rating when no activity date exists. |
| 1 | 4+ years no activity, or archived (archived is always 1). |

Freshness: < 12 months → `fresh`; 12–48 months → `stale`; ≥ 48 months or
archived → `outdated`. When an item's own GitHub metadata cannot be
resolved (batched GraphQL lookup, max 50/query, 5,000 lookups/run; it
needs a token), the item inherits its parent list's rating/freshness.

### Semantic search: TF-IDF (no embeddings, on purpose)

`scripts/build_search_index.py` builds a TF-IDF inverted index over item +
repo + list node names and descriptions and writes
`worker/data/search.json` (format: `{"version": 1, "terms": {term: {idf,
postings: [[nodeId, weight], ...]}}, "norms": {nodeId: float}}`).
Weight is `(1 + ln(tf)) * idf`, `idf = ln(1 + N/df)`; postings are sorted
by weight, capped at 50 per term; terms with df < 2 are dropped unless they
appear in a node's name. The file is trimmed until it fits the 500 KB
budget (current graph: ~2,261 terms, ~349 KB). The worker ranks by TF-IDF
cosine similarity plus synonym expansion — "meaning-based" search with
zero per-query cost.

Neural embeddings are **deliberately deferred**: ~20k items would exceed
the Workers AI free allowance (10k neurons/day) in a single build, and
there is no paid service in this project. Do not "upgrade" the index to
embeddings without a free-tier budget that covers a full rebuild.

```bash
cd scripts
python3 build_search_index.py [graph.json] [--out search.json]
# defaults: ../worker/data/graph.json → ../worker/data/search.json
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

## Security: tokens, trust boundary, runbook (v2)

**Trust boundary:** everything on GitHub Pages is public. The GitHub token lives **only** in
Actions secrets — never in the worker, SPA, or git history. The worker never holds it.
The API is the only trusted boundary.

**GitHub token scopes (sync pipeline):** use a classic PAT with **`public_repo` only**
(no `repo`, no `workflow`, no `gist`, no `read:org`). Set an expiry (≤90 days) and rotate.
Keep it as the `GH_TOKEN` Actions secret. The worker's re-sync trigger (if used) uses a
separate narrow, repo-scoped fine-grained token as `GITHUB_ACTIONS_TOKEN` — never the sync PAT.

**Leak runbook:** on suspected token leak → revoke immediately in GitHub → rotate → review
Actions logs → check GitHub usage/rate-limit page for spikes → audit any graph commits for
unexpected content.

**LLM key modes:** if `LLM_API_KEY` is set server-side, per-request provider overrides are
ignored (env-only mode, prevents server-key exfiltration). Without it, BYOK applies: the SPA
sends its own key, and the base URL is pinned to known providers unless
`LLM_ALLOW_CUSTOM_HOSTS=1` is set.

**Re-sync button:** gated — requires the shared secret (`RESYNC_KEY` worker secret) sent as
`x-resync-key`, max 2/hr/IP, single-flight (409 if already running).

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
├─ scripts/            sync_data.py · sync_data_v2.py · sync_awesome.py · rating.py · build_search_index.py · mock_llm.py · .venv/
├─ data/               graph.json (generated snapshot)
├─ worker/             Cloudflare Worker (TypeScript)
├─ frontend/           Vite + React + Cytoscape SPA
└─ .github/workflows/  GitHub Pages deploy
```
