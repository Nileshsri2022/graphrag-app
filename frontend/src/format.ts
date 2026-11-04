/** "pushed 3mo ago" for an ISO date string; "" when unparseable. */
export function timeAgo(iso?: string, fallback = ""): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  const months = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  if (months < 1) return "this month";
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Human label for a repo node: fullName, falling back to the id without type prefixes. */
export function repoNameOf(n: { fullName?: string; id: string }): string {
  return n.fullName ?? n.id.replace(/^item:/, "").replace(/^pkg:/, "").replace(/^user:/, "");
}

/** npm-style package name: last path segment of the full repo name. */
export function pkgNameOf(n: { fullName?: string; id: string }): string {
  const fn = repoNameOf(n);
  const slash = fn.indexOf("/");
  return slash >= 0 ? fn.slice(slash + 1) : fn;
}
