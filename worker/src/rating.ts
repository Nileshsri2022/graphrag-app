// Rating + freshness rubric (approved 2026-11-22, DESIGN-v2.md §3).
// "How much is this used in the current era": activity first, stars second.
// Stars alone never give a 5 — activity is required.
// The data agent implements the SAME rubric in Python (scripts/sync_awesome.py)
// at sync time and stores rating/freshness/lastActivity on the node; this
// module is the worker-side copy used for ranking + for nodes that predate it.

import type { Node } from "./graph";

export type Freshness = "fresh" | "stale" | "outdated";

const DAYS_PER_MONTH = 30.44;

/** Whole months since the given date string, or null when there is no (valid) date. */
export function monthsSince(dateStr: string | undefined, now = Date.now()): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  const days = Math.max(0, (now - t) / 86_400_000);
  return Math.floor(days / DAYS_PER_MONTH);
}

export function rateNode(opts: {
  archived?: boolean;
  lastActivity?: string;
  stars?: number;
}): { rating: number; freshness: Freshness } {
  if (opts.archived) return { rating: 1, freshness: "outdated" };
  const months = monthsSince(opts.lastActivity);
  if (months === null) return { rating: 2, freshness: "stale" };
  const stars = opts.stars ?? 0;
  if (months < 6) {
    return { rating: stars >= 1000 ? 5 : 4, freshness: "fresh" };
  }
  if (months < 12) {
    return { rating: stars >= 1000 ? 4 : 3, freshness: "fresh" };
  }
  if (months < 24) {
    return { rating: 3, freshness: "stale" };
  }
  if (months < 48) {
    return { rating: 2, freshness: "stale" };
  }
  return { rating: 1, freshness: "outdated" };
}

/** Effective rating/freshness for a node: stored values win when present,
// otherwise derive from archived / lastActivity (falling back to pushedAt) / stars. */
export function nodeRating(n: Node): { rating: number; freshness: Freshness } {
  const derived = rateNode({
    archived: n.archived,
    lastActivity: n.lastActivity ?? n.pushedAt,
    stars: n.stars,
  });
  return {
    rating: n.rating ?? derived.rating,
    freshness: n.freshness ?? derived.freshness,
  };
}

const FRESH_ORDER: Record<Freshness, number> = { fresh: 0, stale: 1, outdated: 2 };

/** Ranking sort: archived last, then freshness (fresh first), then rating desc, then stars desc. */
export function compareRanked(a: Node, b: Node): number {
  // NB: archived is `undefined` (not false) on most nodes — coerce before comparing.
  const aa = a.archived === true;
  const ab = b.archived === true;
  if (aa !== ab) return aa ? 1 : -1;
  const ra = nodeRating(a);
  const rb = nodeRating(b);
  const fresh = FRESH_ORDER[ra.freshness] - FRESH_ORDER[rb.freshness];
  if (fresh !== 0) return fresh;
  if (rb.rating !== ra.rating) return rb.rating - ra.rating;
  return (b.stars ?? 0) - (a.stars ?? 0);
}
