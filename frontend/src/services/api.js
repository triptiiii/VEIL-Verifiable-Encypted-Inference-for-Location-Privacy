/**
 * VEIL — API Service Layer
 *
 * Privacy boundary:
 *   knnPlain()   — sends lat/lng to server (NON-PRIVATE baseline, clearly labelled)
 *   candidates() — sends lat/lng to server for LOCATION-AWARE CANDIDATE
 *                  DISCOVERY ONLY. Coarsened server-side to a ~1.1km grid
 *                  cell before use — see backend/crypto/veil.js. This is a
 *                  deliberate, documented exception to the "no coordinates"
 *                  rule below; it exists so nearby POIs aren't skipped just
 *                  because they weren't first in dataset order.
 *   gcInit()     — sends {k, categories, candidateIds} only — NO COORDINATES
 *   gcResolve()  — sends {sessionId, resultIds} — NO COORDINATES
 *
 * For secure mode, use gcProtocol.runSecureKNN() which orchestrates
 * candidates + gcInit + local evaluation + gcResolve automatically.
 */

const BASE = import.meta.env.VITE_API_URL || "/api";

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  health: () => req("/health"),

  dataset: (categories = null, refresh = false) => {
    const params = new URLSearchParams();
    if (categories?.length) params.set("categories", categories.join(","));
    if (refresh) params.set("refresh", "true");
    return req(`/dataset?${params}`);
  },

  /**
   * Plain (non-private) kNN.
   * SENDS LAT/LNG TO SERVER — this is the non-private baseline.
   * Must be clearly labelled in the UI.
   */
  knnPlain: ({ latitude, longitude, k = 5, categories = null }) =>
    req("/knn/plain", {
      method: "POST",
      body: JSON.stringify({ latitude, longitude, k, categories }),
    }),

  /**
   * Location-aware candidate discovery (Phase 4).
   * SENDS LAT/LNG TO SERVER — coarsened server-side to ~1.1km before use.
   * NOT the secure computation; see module doc comment above.
   */
  candidates: ({ latitude, longitude, categories = null, limit }) =>
    req("/candidates", {
      method: "POST",
      body: JSON.stringify({ latitude, longitude, categories, limit }),
    }),

  /**
   * Secure GC — Step 1: Request garbled circuit.
   * Does NOT send coordinates. Sends only {k, categories, candidateIds}.
   */
  gcInit: ({ k = 5, categories = null, candidateIds = null }) =>
    req("/gc/init", {
      method: "POST",
      body: JSON.stringify({ k, categories, candidateIds }), // ← no lat/lng
    }),

  /**
   * Secure GC — Step 2: Resolve result ids to POI data.
   * Does NOT send coordinates. Sends only {sessionId, resultIds}.
   */
  gcResolve: ({ sessionId, resultIds }) =>
    req("/gc/resolve", {
      method: "POST",
      body: JSON.stringify({ sessionId, resultIds }), // ← no lat/lng
    }),

  complexity: (k = 5) => req(`/complexity?k=${k}`),

  verify: ({ leafHash, proof, root }) =>
    req("/verify", {
      method: "POST",
      body: JSON.stringify({ leafHash, proof, root }),
    }),

  otBenchmark: (m = 64) => req(`/ot/benchmark?m=${m}`),
};
