import { useState } from "react";
import type { GraphNode } from "./api";

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const months = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  if (months < 1) return "pushed this month";
  if (months < 12) return `pushed ${months}mo ago`;
  const years = Math.floor(months / 12);
  return `pushed ${years}y ago`;
}

function fullNameOf(n: GraphNode): string {
  return n.fullName ?? n.id.replace(/^item:/, "").replace(/^pkg:/, "").replace(/^user:/, "");
}

function pkgName(n: GraphNode): string {
  const fn = fullNameOf(n);
  const slash = fn.indexOf("/");
  return slash >= 0 ? fn.slice(slash + 1) : fn;
}

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
        const fn = fullNameOf(r);
        const isArchived = r.archived === true;
        const age = timeAgo(r.pushedAt);
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
                {age && <span className="meta-item muted">{age}</span>}
                {isArchived && <span className="badge archived">archived</span>}
              </div>
            </div>
            {r.description && <p className="repo-card-desc">{r.description}</p>}
            <div className="repo-card-foot">
              {!isArchived ? (
                <button
                  className={`install-chip${copied === pkgName(r) ? " copied" : ""}`}
                  onClick={() => copy(pkgName(r))}
                  title="Copy to clipboard"
                >
                  {copied === pkgName(r) ? "✓ copied" : `npm i ${pkgName(r)}`}
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
