import HistoryChart, { formatINR } from './HistoryChart.jsx';
import AttemptLog, { fmtTime } from './AttemptLog.jsx';

/**
 * Everything known about one tracked product.
 *
 * The order is deliberate: current state, then the price series, then the raw
 * observations, then every attempt. The scrape log is last because it is the
 * evidence — when the price series looks strange, the answer is almost always in
 * the attempts directly beneath it.
 */
export default function ProductDetail({ product, history, attempts, note, loading, error, onUntrack, untracking }) {
  if (!product) {
    return (
      <div className="panel">
        <p className="empty">
          Select a tracked product on the left, or search the store to track a new one.
        </p>
      </div>
    );
  }

  const latest = history?.[0] ?? null;
  const sorted = latest ? [...history].sort((a, b) => Date.parse(b.scrapedAt) - Date.parse(a.scrapedAt)) : [];

  return (
    <>
      <div className="panel">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ textTransform: 'none', fontSize: 17, color: 'var(--text)', margin: '0 0 4px' }}>
              {product.productName}
            </h2>
            <div className="muted">
              {product.brand} · {product.category} · <span className="mono">{product.sku}</span>
            </div>
          </div>
          <div className="flex">
            <a href={product.sourceUrl} target="_blank" rel="noreferrer noopener">
              View in store ↗
            </a>
            <button className="danger" onClick={onUntrack} disabled={untracking}>
              {untracking ? 'Stopping…' : 'Stop tracking'}
            </button>
          </div>
        </div>

        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>Option tracked</dt>
          <dd>
            {product.optionLabel} <span className="muted">({product.optionAxis ?? 'variant'})</span>
          </dd>
          <dt>Store product id</dt>
          <dd>{product.storeProductId}</dd>
          <dt>Latest price</dt>
          <dd>{latest ? formatINR(latest.price) : <span className="muted">no successful read yet</span>}</dd>
          <dt>Latest stock</dt>
          <dd>{latest ? (latest.stock ?? '—') : <span className="muted">—</span>}</dd>
          <dt>Last checked</dt>
          <dd>{product.lastScrapedAt ? `${fmtTime(product.lastScrapedAt)} UTC` : <span className="muted">never</span>}</dd>
          <dt>Successful reads</dt>
          <dd>{history?.length ?? 0}</dd>
        </dl>
      </div>

      {error && <div className="notice bad">{error.message}</div>}

      <div className="panel">
        <h2>Price history</h2>
        {loading ? <p className="hint">Loading…</p> : <HistoryChart history={history} />}
        {note && <p className="hint">{note}</p>}
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Observations</h2>
          {sorted.length === 0 ? (
            <p className="empty">No observations yet.</p>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Scraped (UTC)</th>
                    <th className="num">Price</th>
                    <th className="num">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((h) => (
                    <tr key={h.id}>
                      <td className="mono">{fmtTime(h.scrapedAt)}</td>
                      <td className="num">{formatINR(h.price)}</td>
                      <td className="num">{h.stock ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Scrape log</h2>
          {loading ? <p className="hint">Loading…</p> : <AttemptLog attempts={attempts} />}
        </div>
      </div>
    </>
  );
}
