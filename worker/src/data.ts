// R2-backed data loading for the worker.
//
// graph.json (~13-15 MB) and search.json (~5 MB) are too large to bundle into
// the Worker (free limit: 1 MB compressed). They live in the Cloudflare R2
// bucket "graphrag-data" (free tier) and are fetched once per isolate at cold
// start, then cached in memory. Missing/invalid objects leave that feature
// disabled — the worker never crashes on bad data.
//
// The sync workflow uploads both files to R2 after every data refresh; local
// dev seeds a local R2 bucket with:
//   wrangler r2 object put --local graphrag-data/graph.json --file=../data/graph.json
//   wrangler r2 object put --local graphrag-data/search.json --file=../data/search.json

import { isGraphLoaded, loadGraphData, resetGraphForTesting } from "./graph";
import { isTfidfEnabled, loadSearchIndex, resetSearchIndexForTesting } from "./tfidf";

/** Minimal structural type for an R2 bucket (the real R2Bucket satisfies it). */
export type R2BucketLike = {
  get(key: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> } | null>;
};

export type DataStatus = { graph: boolean; search: boolean };

type GlobalDataState = { __graphragDataLoad?: Promise<DataStatus> };
const G = globalThis as unknown as GlobalDataState;

/** Current load status (no fetching). */
export function dataStatus(): DataStatus {
  return { graph: isGraphLoaded(), search: isTfidfEnabled() };
}

/**
 * Idempotent cold-start loader. The first call fetches graph.json + search.json
 * from the DATA bucket; later calls (including concurrent ones) share the same
 * promise. Never throws: a missing bucket, a missing object, or invalid JSON
 * just leaves that feature disabled.
 */
export function ensureData(env: unknown): Promise<DataStatus> {
  if (!G.__graphragDataLoad) {
    G.__graphragDataLoad = loadOnce(env);
  }
  return G.__graphragDataLoad;
}

async function loadOnce(env: unknown): Promise<DataStatus> {
  const status: DataStatus = dataStatus();
  const bucket = (env as { DATA?: R2BucketLike } | null | undefined)?.DATA;
  if (!bucket || typeof bucket.get !== "function") return status;
  try {
    const obj = await bucket.get("graph.json");
    if (obj) {
      const raw = await obj.json();
      if (loadGraphData(raw)) status.graph = true;
    }
  } catch {
    // missing/invalid graph.json -> graph features disabled, never a crash
  }
  try {
    const obj = await bucket.get("search.json");
    if (obj) {
      const raw = await obj.json();
      if (loadSearchIndex(raw)) status.search = true;
    }
  } catch {
    // missing/invalid search.json -> TF-IDF disabled, never a crash
  }
  return status;
}

/**
 * Test-only: clear the loader promise and the loaded graph + index, so a test
 * can load fresh data. Production code never calls this.
 */
export function resetDataForTesting(): void {
  G.__graphragDataLoad = undefined;
  resetGraphForTesting();
  resetSearchIndexForTesting();
}
