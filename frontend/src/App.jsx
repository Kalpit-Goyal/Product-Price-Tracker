import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getHealth,
  getProducts,
  getHistory,
  getAttempts,
  untrackProduct,
  csvUrl,
  startRun,
  getRun,
  ApiError,
} from './api/client.js';
import SearchPanel from './components/SearchPanel.jsx';
import TrackedProducts from './components/TrackedProducts.jsx';
import ProductDetail from './components/ProductDetail.jsx';

const POLL_MS = 60000;

/**
 * Format a timestamp as "3h ago" / "2d ago" — used for freshness, where the exact
 * time is less important than how stale the number is.
 */
function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  const mins = ms / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 48) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState({ history: null, attempts: null, note: null, loading: false, error: null });
  const [untracking, setUntracking] = useState(false);
  const [runState, setRunState] = useState(null);
  const runPollRef = useRef(null);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await getHealth());
      setHealthError(null);
    } catch (err) {
      setHealthError(err);
    }
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const data = await getProducts();
      setProducts(data.products ?? []);
      setProductsLoading(false);
    } catch (err) {
      setProductsLoading(false);
      setHealthError(err);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadProducts();
    const timer = setInterval(() => {
      loadHealth();
      loadProducts();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadHealth, loadProducts]);

  // Select the first product automatically so the dashboard is never an empty shell.
  useEffect(() => {
    if (!selectedId && products.length > 0) setSelectedId(products[0].id);
    // If the selected product was deleted, move to whatever is left.
    if (selectedId && products.length > 0 && !products.some((p) => p.id === selectedId)) {
      setSelectedId(products[0].id);
    }
  }, [products, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail({ history: null, attempts: null, note: null, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setDetail((d) => ({ ...d, loading: true, error: null }));

    // History and attempts are fetched together because the scrape log is the
    // evidence for the price series; showing one without the other invites the
    // reader to over-interpret whichever arrived first.
    Promise.all([getHistory(selectedId), getAttempts(selectedId)])
      .then(([h, a]) => {
        if (cancelled) return;
        setDetail({
          history: h.history ?? [],
          attempts: a.attempts ?? [],
          note: h.note ?? null,
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setDetail((d) => ({ ...d, loading: false, error: err }));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selected = products.find((p) => p.id === selectedId) ?? null;

  const handleUntrack = async () => {
    if (!selected) return;
    setUntracking(true);
    try {
      await untrackProduct(selected.id);
      setSelectedId(null);
      await loadProducts();
      await loadHealth();
    } catch (err) {
      setDetail((d) => ({ ...d, error: err }));
    } finally {
      setUntracking(false);
    }
  };

  /**
   * Trigger a scrape, but only when the backend says that is permitted.
   *
   * WHY THIS IS GATED ON A SERVER FLAG. POST /api/scrape/run requires the cron
   * secret. Anything in this bundle is public, so the deployed dashboard must never
   * be able to trigger a run — that would let any visitor start scrapes against the
   * store. In production the backend reports allowManualRun: false and the button is
   * not rendered; the cron job is the only trigger. Locally, with
   * ALLOW_DEV_TRIGGER=1, the button appears and calls the endpoint with no secret,
   * which is why the dev secret is a placeholder in the developer's own machine.
   */
  const handleRun = async () => {
    setRunState({ phase: 'starting' });
    try {
      const res = await startRun(null);
      setRunState({ phase: 'accepted', runId: res.runId, status: res.status });
      pollRun(res.runId);
    } catch (err) {
      setRunState({ phase: 'failed', error: err instanceof ApiError ? err.message : String(err) });
    }
  };

  const pollRun = (runId) => {
    clearInterval(runPollRef.current);
    // The run is async and can take a while, so poll until it reports a terminal
    // state. A scrape that silently stops updating is worse than one that says it
    // is still going.
    runPollRef.current = setInterval(async () => {
      try {
        const run = await getRun(runId);
        setRunState((s) => ({ ...s, phase: 'running', run }));
        if (run.status !== 'running' && run.status !== 'pending') {
          clearInterval(runPollRef.current);
          setRunState((s) => ({ ...s, phase: 'done' }));
          loadProducts();
          loadHealth();
        }
      } catch (err) {
        clearInterval(runPollRef.current);
        setRunState((s) => ({ ...s, phase: 'failed', error: err.message }));
      }
    }, 3000);
  };

  useEffect(() => () => clearInterval(runPollRef.current), []);

  return (
    <div className="app">
      <header className="topbar">
        <h1>INE Store Price Tracker</h1>
        <div className="status-strip">
          <span>
            status <b>{healthError ? 'unreachable' : (health?.status ?? '…')}</b>
          </span>
          <span>
            tracked <b>{health?.trackedProducts ?? '—'}</b>
          </span>
          <span>
            successes <b>{health?.successes ?? '—'}</b>
          </span>
          <span>
            last read <b>{ago(health?.lastSuccessAt)}</b>
          </span>
        </div>
        <div className="spacer" />
        <button onClick={() => { loadHealth(); loadProducts(); }}>Refresh</button>
        <a href={csvUrl()} download="ine-attempts.csv">
          <button>Export CSV</button>
        </a>
        {health?.allowManualRun && (
          <button className="primary" onClick={handleRun} disabled={runState?.phase === 'starting'}>
            Run scraper now
          </button>
        )}
      </header>

      {healthError && (
        <div style={{ padding: '12px 20px 0' }}>
          <div className="notice bad">
            {healthError.message}
            {healthError.code === 'network_error' && (
              <div className="hint">
                Is the backend running, and is <span className="mono">VITE_API_BASE_URL</span> set correctly?
              </div>
            )}
          </div>
        </div>
      )}

      {runState && (
        <div style={{ padding: '12px 20px 0' }}>
          <RunNotice state={runState} onDismiss={() => setRunState(null)} />
        </div>
      )}

      {health && !health.allowManualRun && (
        <div style={{ padding: '12px 20px 0' }}>
          <div className="notice">
            Scrapes are started by an external cron job every 2 hours, not by this page. The trigger
            requires a server-side secret, so the dashboard cannot start one — that is deliberate.
          </div>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <SearchPanel
            onTracked={async () => {
              await loadProducts();
              await loadHealth();
            }}
          />
          <div className="panel">
            <h2>Tracked products</h2>
            <TrackedProducts
              products={products}
              selectedId={selectedId}
              onSelect={setSelectedId}
              loading={productsLoading}
            />
          </div>
        </aside>

        <main className="main">
          <ProductDetail
            product={selected}
            history={detail.history}
            attempts={detail.attempts}
            note={detail.note}
            loading={detail.loading}
            error={detail.error}
            onUntrack={handleUntrack}
            untracking={untracking}
          />
        </main>
      </div>
    </div>
  );
}

/**
 * Live run state.
 *
 * The requirement is that the state machine itself is visible — loading, retrying
 * n/6, failed — so the screen recording shows the scraper working rather than a
 * closed browser. This reflects whatever the run endpoint reports and never
 * smooths over a failure.
 */
function RunNotice({ state, onDismiss }) {
  if (state.phase === 'failed') {
    return (
      <div className="notice bad">
        Run failed to start: {state.error}{' '}
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    );
  }

  const run = state.run;
  if (state.phase === 'accepted') {
    return (
      <div className="notice good">
        Run {state.runId} accepted. Scraping takes a little while — this page will follow it.{' '}
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    );
  }

  if (run) {
    const terminal = run.status !== 'running' && run.status !== 'pending';
    return (
      <div className={`notice ${terminal && run.failed > 0 ? 'warn' : 'good'}`}>
        Run {run.id}: <b>{run.status}</b>
        {run.attempted != null && (
          <>
            {' '}
            · attempted {run.attempted} · succeeded {run.succeeded} · failed {run.failed}
          </>
        )}
        {run.error && <div className="hint">{run.error}</div>}
        {terminal && (
          <>
            {' '}
            <button onClick={onDismiss}>Dismiss</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="notice">
      Starting run…{' '}
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
