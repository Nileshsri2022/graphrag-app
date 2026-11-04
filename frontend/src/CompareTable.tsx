import type { GraphNode, Subgraph } from "./api";

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const months = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  if (months < 1) return "this month";
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function repoName(n: GraphNode): string {
  return n.fullName ?? n.id;
}

function pickCompareRepos(subgraph: Subgraph, label: string): GraphNode[] {
  const repos = subgraph.nodes.filter((n) => n.type === "repo");
  const m = label.match(/compare:(.*)/);
  if (m) {
    const wanted = m[1]
      .split("|")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (wanted.length >= 2) {
      const found = wanted
        .map((w) => repos.find((r) => repoName(r).toLowerCase() === w || r.id.toLowerCase() === w))
        .filter((x): x is GraphNode => Boolean(x));
      if (found.length >= 1) return found.slice(0, 2);
    }
  }
  return repos.slice(0, 2);
}

export default function CompareTable({ subgraph, label }: { subgraph: Subgraph; label: string }) {
  const repos = pickCompareRepos(subgraph, label);
  if (repos.length === 0) return null;

  return (
    <div className="compare-wrap">
      <div className="compare-title">Compare</div>
      <div className="compare-table-scroll">
        <table className="compare-table">
          <thead>
            <tr>
              <th>Repo</th>
              <th>★ Stars</th>
              <th>Forks</th>
              <th>Language</th>
              <th>Archived</th>
              <th>Last push</th>
              <th>Size KB</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.id}>
                <td className="compare-repo">{repoName(r)}</td>
                <td>{r.stars?.toLocaleString() ?? "—"}</td>
                <td>{r.forks?.toLocaleString() ?? "—"}</td>
                <td>{r.language || "—"}</td>
                <td>{r.archived ? <span className="badge archived">archived</span> : "—"}</td>
                <td>{timeAgo(r.pushedAt)}</td>
                <td>{r.sizeKB?.toLocaleString() ?? "—"}</td>
                <td>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer" className="card-link">open ↗</a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
