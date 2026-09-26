import { useMemo, useState } from 'react';

const W = 720;
const H = 220;
const PAD = { top: 14, right: 16, bottom: 26, left: 56 };

/**
 * Price history as a time-series line chart.
 *
 * WHY HAND-ROLLED SVG INSTEAD OF A CHART LIBRARY. Two reasons, both about honesty
 * rather than effort:
 *
 *  1. The x axis is REAL time, not a category index. Scrapes run every two hours but
 *     a run can fail, so the gaps are uneven — a 6-hour hole between points is a
 *     genuinely different thing from a 2-hour one. Libraries that assume evenly
 *     spaced categories quietly turn that into a lie: the line looks continuous when
 *     the data is not.
 *  2. There is no price trend to show. The store re-rolls its price on every page
 *     load, so this is a scatter of independent observations, not a value evolving
 *     over time. Drawing it as a smooth "price history" curve implies a continuity
 *     that does not exist, so the points are marked individually and the caption
 *     says what the series actually is.
 */
export default function HistoryChart({ history }) {
  const [hover, setHover] = useState(null);

  const points = useMemo(
    () =>
      (history ?? [])
        .map((h) => ({ ...h, t: Date.parse(h.scrapedAt), price: Number(h.price) }))
        .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.price) && h.price > 0)
        .sort((a, b) => a.t - b.t),
    [history]
  );

  if (points.length === 0) {
    return (
      <p className="empty">
        No successful observations yet. Price history only ever contains validated reads — a failed
        attempt is logged in the scrape log below, never here.
      </p>
    );
  }

  const times = points.map((p) => p.t);
  const prices = points.map((p) => p.price);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);

  // A single observation, or several at one price, would divide by zero below. Pad a
  // flat series by a percent of its own value so the line lands mid-chart instead of
  // on an edge, and give a lone point a one-hour window.
  const priceSpan = pMax - pMin || Math.max(1, pMax * 0.02);
  const lo = pMin - priceSpan * 0.15;
  const hi = pMax + priceSpan * 0.15;
  const tSpan = t1 - t0 || 60 * 60 * 1000;

  const x = (t) => PAD.left + ((t - t0) / tSpan) * (W - PAD.left - PAD.right);
  const y = (p) => PAD.top + (1 - (p - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const yTicks = tickValues(lo, hi, 4);
  const xTicks = tickValues(t0, t1, 4);
  const latest = points[points.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={`Price history, ${points.length} observations from ${new Date(t0).toISOString()} to ${new Date(t1).toISOString()}`}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#2a2f3a" strokeWidth="1" />
            <text x={PAD.left - 8} y={y(v) + 4} fill="#99a1b3" fontSize="11" textAnchor="end">
              {formatINR(v, true)}
            </text>
          </g>
        ))}

        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 8} fill="#99a1b3" fontSize="11" textAnchor="middle">
            {formatDate(t)}
          </text>
        ))}

        {points.length > 1 && <path d={path} fill="none" stroke="#5b8cff" strokeWidth="1.5" opacity="0.55" />}

        {points.map((p, i) => (
          <circle
            key={p.id ?? i}
            cx={x(p.t)}
            cy={y(p.price)}
            r={hover?.id === (p.id ?? i) ? 5 : 3}
            fill="#5b8cff"
            stroke="#0f1115"
            strokeWidth="1"
            onMouseEnter={() => setHover({ ...p, id: p.id ?? i, cx: x(p.t), cy: y(p.price) })}
          />
        ))}
      </svg>

      <div className="chart-legend">
        <span>
          <span className="swatch" style={{ background: '#5b8cff' }} />
          {points.length} successful observation{points.length === 1 ? '' : 's'}
        </span>
        <span>
          Latest {formatINR(latest.price)} · min {formatINR(pMin)} · max {formatINR(pMax)}
        </span>
        {points.length > 1 && <span>spans {formatSpan(t1 - t0)}</span>}
      </div>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: Math.min(hover.cx + 12, window.innerWidth - 280),
            top: Math.max(hover.cy - 60, 8),
          }}
        >
          <div className="t-price">{formatINR(hover.price)}</div>
          <div className="muted">{new Date(hover.t).toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
          <div className="muted">stock: {hover.stock ?? '—'}</div>
        </div>
      )}
    </div>
  );
}

function tickValues(lo, hi, count) {
  const out = [];
  for (let i = 0; i <= count; i++) out.push(lo + ((hi - lo) * i) / count);
  return out;
}

export function formatINR(value, compact = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (compact && Math.abs(n) >= 100000) {
    return `₹${(n / 100000).toFixed(1)}L`;
  }
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function formatDate(t) {
  return new Date(t).toISOString().slice(5, 16).replace('T', ' ');
}

function formatSpan(ms) {
  const h = ms / 3600000;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
