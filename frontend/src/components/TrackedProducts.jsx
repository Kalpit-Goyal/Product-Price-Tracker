import { formatINR } from './HistoryChart.jsx';
import { fmtTime } from './AttemptLog.jsx';

/**
 * The tracked list.
 *
 * WHY EACH ROW SHOWS ITS OWN LAST-CHECKED TIME. A stale price with no timestamp
 * reads as a current price. The whole point of the dashboard is that you can tell
 * how fresh a number is, so the time is part of the row rather than hidden in a
 * tooltip.
 */
export default function TrackedProducts({ products, selectedId, onSelect, loading }) {
  if (loading && products.length === 0) {
    return <p className="hint">Loading tracked products…</p>;
  }

  if (products.length === 0) {
    return (
      <p className="hint">
        Nothing tracked yet. Search the store above to track a product and its price history will
        appear here after the next scheduled run.
      </p>
    );
  }

  return (
    <div>
      {products.map((p) => {
        // Field names come straight from GET /api/products: latestPrice and
        // latestStock are explicitly null when there has never been a success, which
        // is different from a price of 0 and must render differently.
        const last = p.latestPrice ?? null;
        // Freshness is judged on the last successful read, not on when the row was
        // written, so a product that keeps failing goes stale and says so.
        const seenAt = p.latestScrapedAt ?? p.lastScrapedAt ?? null;
        const stale = seenAt && Date.now() - Date.parse(seenAt) > 6 * 3600 * 1000;
        return (
          <button
            key={p.id}
            className={`tracked-item ${p.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(p.id)}
            aria-current={p.id === selectedId}
          >
            <div className="row1">
              <span>{p.productName}</span>
              <span className="price">{last == null ? '—' : formatINR(last)}</span>
            </div>
            <div className="sub">
              {p.optionLabel} · stock {p.latestStock ?? '—'}
            </div>
            <div className="sub">
              {seenAt ? (
                <>
                  last read {fmtTime(seenAt)} UTC{stale ? ' · stale' : ''}
                </>
              ) : (
                'not scraped yet'
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
