import { useState } from "react";
import type { GraphNode } from "./api";
import { pkgNameOf, repoNameOf, timeAgo } from "./format";

export default function ResultCards({ repos }: { repos: GraphNode[] }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(`npm i ${name}`);
      setCopied(name);
      setTimeout(() => setCopied((c) => (c === name ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (repos.length === 0) return null;

  return (
    <div className="result-cards">
      {repos.map((r) => {
        const fn = repoNameOf(r);
        const isArchived = r.archived === true;
        const age = timeAgo(r.pushedAt, "").replace("pushed ", "");
        return (
          <div key={r.id} className={`repo-card${isArchived ? " archived" : ""}`}>
            <div className="repo-card-head">
              <a className="repo-card-name" href={r.url} target="_blank" rel="noreferrer">
                {fn}
              </a>
              <div className="repo-card-meta">
                {r.stars !== undefined && (
                  <span className="meta-item" title="Stars">★ {r.stars.toLocaleString()}</span>
                )}
                {r.forks !== undefined && (
                  <span className="meta-item" title="Forks">⑂ {r.forks.toLocaleString()}</span>
                )}
                {r.language && <span className="meta-item">{r.language}</span>}
                {age && <span className="meta-item muted">pushed {age}</span>}
                {isArchived && <span className="badge archived">archived</span>}
              </div>
            </div>
            {r.description && <p className="repo-card-desc">{r.description}</p>}
            <div className="repo-card-foot">
              {!isArchived ? (
                <button
                  className={`install-chip${copied === pkgNameOf(r) ? " copied" : ""}`}
                  onClick={() => copy(pkgNameOf(r))}
                  title="Copy to clipboard"
                >
                  {copied === pkgNameOf(r) ? "✓ copied" : `npm i ${pkgNameOf(r)}`}
                </button>
              ) : (
                <span className="no-install">no install — archived</span>
              )}
              <div className="repo-card-links">
                {r.homepage && (
                  <a href={r.homepage} target="_blank" rel="noreferrer" className="card-link">homepage ↗</a>
                )}
                {r.url && (
                  <a href={r.url} target="_blank" rel="noreferrer" className="card-link">GitHub ↗</a>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
