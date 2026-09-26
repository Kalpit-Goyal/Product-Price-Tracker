import { useEffect, useRef, useState } from 'react';
import { searchProducts, getOptions, trackProduct, ApiError } from '../api/client.js';

/**
 * Search the store and track a product + option.
 *
 * WHY SEARCH IS DEBOUNCED AND ABORTABLE. Typing "capture card" fires eight
 * keystrokes. Without debouncing that is eight catalog searches, each of which may
 * walk the store. The AbortController is not an optimisation either: without it, a
 * slow early request can resolve *after* a fast later one and overwrite the newer
 * results with stale ones.
 */
const DEBOUNCE_MS = 300;

export default function SearchPanel({ onTracked }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [picking, setPicking] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setError(null);
      setSearching(false);
      return undefined;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const data = await searchProducts(q, { signal: controller.signal });
        setResults(data);
        setError(null);
      } catch (err) {
        // A superseded request is not a failure worth showing anyone.
        if (err.name === 'AbortError') return;
        setError(err);
        setResults(null);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="panel">
      <h2>Search the store</h2>
      <input
        className="search-input"
        type="search"
        placeholder="e.g. capture card"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search products by name"
      />

      {searching && <p className="hint">Searching…</p>}

      {error && (
        <div className={`notice ${error.isRateLimited ? 'warn' : 'bad'}`}>
          {error.isRateLimited
            ? `The store is rate limiting us right now. ${error.message}`
            : error.message}
        </div>
      )}

      {results && !error && (
        <>
          <p className="hint">
            {results.resultCount} match{results.resultCount === 1 ? '' : 'es'} for “{results.query}” out of{' '}
            {results.catalogSize} indexed products.
          </p>

          {/* The index is built by sampling a paginated endpoint that overlaps, so it
              is nearly — but not guaranteed to be — complete. Saying so beats
              implying a product does not exist. */}
          {results.indexComplete === false && (
            <div className="notice warn">
              The search index covers {Math.round((results.indexCoverage ?? 0) * 100)}% of the store, so a few
              products may be missing from these results.
            </div>
          )}

          {results.resultCount === 0 && <p className="hint">No matches.</p>}

          {results.results.map((r) => (
            <div className="result" key={r.id}>
              <div>
                <div className="name">{r.name}</div>
                <div className="meta">
                  {r.brand} · {r.category} · {r.sku}
                </div>
              </div>
              <button onClick={() => setPicking(r)}>Track</button>
            </div>
          ))}
        </>
      )}

      {picking && (
        <TrackDialog
          product={picking}
          onClose={() => setPicking(null)}
          onTracked={(res) => {
            setPicking(null);
            onTracked(res);
          }}
        />
      )}
    </div>
  );
}

/**
 * Option picker.
 *
 * WHY THE OPTIONS ARE FETCHED RATHER THAN GUESSED. A product's price depends on the
 * variant, so tracking "the product" without naming a variant would record a price
 * for something the user never asked about. The backend refuses an option that does
 * not exist precisely to stop that, so the UI has to know the real list.
 */
function TrackDialog({ product, onClose, onTracked }) {
  const [state, setState] = useState({ loading: true, options: null, error: null, axis: null });
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getOptions(product.id)
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, options: data.options, axis: data.optionAxis, error: null });
        setChoice(data.options[0]?.id ?? '');
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, options: null, error: err, axis: null });
      });
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await trackProduct({ storeProductId: product.id, optionId: choice });
      onTracked(res);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err : new ApiError(String(err)));
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 100,
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ width: 'min(440px, 100%)', margin: 0 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Track ${product.name}`}
      >
        <h2>Track {product.name}</h2>

        {state.loading && <p className="hint">Loading options…</p>}

        {state.error && (
          <div className={`notice ${state.error.isRateLimited ? 'warn' : 'bad'}`}>{state.error.message}</div>
        )}

        {state.options?.length === 0 && (
          <div className="notice bad">
            This product exposes no options, so there is no option+price pair to track.
          </div>
        )}

        {state.options?.length > 0 && (
          <>
            <p className="hint">
              The price depends on the variant. Pick the {state.axis ?? 'variant'} to track.
            </p>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              aria-label="Option"
              style={{ width: '100%', marginTop: 8 }}
            >
              {state.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </>
        )}

        {saveError && (
          <div className={`notice ${saveError.isRateLimited ? 'warn' : 'bad'}`} style={{ marginTop: 12 }}>
            {saveError.message}
            {Array.isArray(saveError.payload?.available) && saveError.payload.available.length > 0 && (
              <div className="hint">
                Available: {saveError.payload.available.map((o) => o.label).join(', ')}
              </div>
            )}
          </div>
        )}

        <div className="flex" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={submit}
            disabled={saving || !state.options?.length}
          >
            {saving ? 'Tracking…' : 'Start tracking'}
          </button>
        </div>
      </div>
    </div>
  );
}
