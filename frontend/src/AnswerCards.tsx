import type { AnswerCard } from "./api";
import { timeAgo } from "./format";

/** Monogram initials from a tool name ("pytest" -> "PY", "static-site-generator" -> "SS"). */
function initials(name: string): string {
  const parts = name.replace(/[-_]/g, " ").split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts[1]?.[0] ?? "";
  return (first + second).toUpperCase();
}

/** 5-star rating display: filled stars by rating, empty stars for the rest. */
export function RatingStars({ rating }: { rating: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="rating" title={`Rating ${rating} out of 5`}>
      <span aria-hidden="true">
        {"★".repeat(filled)}
        <span className="stars-empty">{"☆".repeat(5 - filled)}</span>
      </span>
      <span className="rating-num">{rating.toFixed(1)}</span>
    </span>
  );
}

export function FreshnessBadge({ freshness }: { freshness: AnswerCard["freshness"] }) {
  if (freshness === "fresh") {
    return (
      <span className="fresh-badge fresh">
        <span className="fresh-dot" /> Fresh
      </span>
    );
  }
  if (freshness === "stale") {
    return (
      <span className="fresh-badge stale">
        <span className="fresh-dot" /> Stale
      </span>
    );
  }
  return (
    <span className="fresh-badge outdated">
      <span className="fresh-dot" /> Outdated
    </span>
  );
}

/**
 * Ranked answer cards (#1/#2/#3...). Items have no thumbnails, so each card
 * uses a monogram tile instead of an <img>. "Votes" = GitHub stars — there is
 * no voting backend in v2, so no second votes number is invented.
 */
export default function AnswerCards({ cards }: { cards: AnswerCard[] }) {
  if (cards.length === 0) return null;

  return (
    <div className="answer-cards">
      {cards.map((c) => {
        const updated = timeAgo(c.lastActivity, "");
        return (
          <article key={c.id} className={`answer-card${c.freshness === "outdated" ? " outdated" : ""}`}>
            <div className="answer-top">
              <div className="answer-id">
                <span className={`rank-badge${c.rank === 1 ? " first" : ""}`}>#{c.rank}</span>
                <span className="monogram" aria-hidden="true">
                  {initials(c.name)}
                </span>
                <div className="answer-title">
                  <div className="card-name-row">
                    {c.url ? (
                      <a className="card-name" href={c.url} target="_blank" rel="noreferrer">
                        {c.name}
                      </a>
                    ) : (
                      <h2 className="card-name">{c.name}</h2>
                    )}
                    {c.type && <span className="type-chip">{c.type}</span>}
                  </div>
                  {c.fullName && <span className="card-fullname">{c.fullName}</span>}
                </div>
              </div>
              <div className="metrics-pill">
                {c.stars !== undefined && (
                  <span title="GitHub stars">★ {c.stars.toLocaleString()} stars</span>
                )}
                {updated && (
                  <>
                    <span className="metrics-sep">/</span>
                    <span>Updated {updated}</span>
                  </>
                )}
                <span className="metrics-sep">/</span>
                <RatingStars rating={c.rating} />
                <span className="metrics-sep">/</span>
                <FreshnessBadge freshness={c.freshness} />
              </div>
            </div>

            {c.description && <p className="answer-desc">{c.description}</p>}

            {c.why && (
              <div className="why-box">
                <span className="why-label">Why it fits</span>
                <p>{c.why}</p>
              </div>
            )}

            <div className="card-actions">
              {c.listName && <span className="list-chip">from {c.listName}</span>}
              {c.language && <span className="lang-chip">{c.language}</span>}
              <span className="spacer" />
              {c.url && (
                <a className="btn primary open-repo" href={c.url} target="_blank" rel="noreferrer">
                  Open repo ↗
                </a>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
