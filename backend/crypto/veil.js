/**
 * VEIL — Server-Side Session Orchestrator
 *
 * Privacy boundary:
 *   plainQuery(lat, lng)        — NON-PRIVATE baseline. Receives coordinates.
 *   buildSecureCircuit(k, cats) — SECURE path. NEVER receives coordinates.
 *   resolveSecureQuery(...)     — SECURE path. Receives only result POI ids.
 *
 * The server's role in the secure protocol:
 *   1. Own the POI dataset
 *   2. Garble the kNN circuit over that dataset
 *   3. Send the garbled bundle to the client (no coordinates ever arrive)
 *   4. Receive result POI ids from the client after evaluation
 *   5. Return POI metadata + Merkle proofs
 */

import { garbleCircuit, buildClientBundle } from "./gc/garbledCircuit.js";
import {
  buildDatasetCommitment,
  generateResultProofs,
  verifyResults,
} from "./merkle/merkleTree.js";
import { plainKNN, complexityReport } from "../geometry/knn.js";

const COORD_BITS = 32;
const SCALE = 1e6;

// Max POIs in a secure circuit (keeps circuit size / latency manageable for demo).
const MAX_SECURE_POIS = 30;

// Candidate-discovery coarsening grid, in degrees. 0.01° ≈ 1.11km north-south
// and ≈ 1.08km east-west at Bengaluru's latitude (~13°N). This is the ONLY
// location information candidate discovery ever receives or stores — see
// getLocationAwareCandidates() below and README "Candidate Discovery vs
// Secure Computation" for the full privacy trade-off writeup.
const CANDIDATE_COARSEN_DECIMALS = 2;

function coarsen(deg) {
  const f = 10 ** CANDIDATE_COARSEN_DECIMALS;
  return Math.round(deg * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE ENCODING (server-side copy for complexity reporting only)
// The ACTUAL encoding used in the protocol runs CLIENT-SIDE (gcProtocol.js).
// ─────────────────────────────────────────────────────────────────────────────

function encodeCoordinate(coord) {
  const scaled = Math.round(Math.abs(coord) * SCALE);
  const bits = [];
  for (let i = 0; i < COORD_BITS; i++) bits.push((scaled >> i) & 1);
  return bits;
}

// ─────────────────────────────────────────────────────────────────────────────
// VEIL SESSION
// ─────────────────────────────────────────────────────────────────────────────

export class VEILSession {
  constructor(pois) {
    this.pois = pois;
    this.commitment = buildDatasetCommitment(pois);
    this.merkleRoot = this.commitment.root;
    console.log(
      `[VEIL] Session ready: ${pois.length} POIs | Merkle root ${this.merkleRoot.slice(0, 16)}...`
    );
  }

  // ── PLAIN kNN (non-private baseline) ──────────────────────────────────────

  /**
   * Plain kNN. Receives lat/lng in plaintext.
   * Clearly labelled as NON-PRIVATE in the API response.
   */
  plainQuery(lat, lng, k = 5, categories = null) {
    const t0 = performance.now();
    const results = plainKNN({ latitude: lat, longitude: lng }, this.pois, k, categories);
    const elapsed = (performance.now() - t0).toFixed(2);
    return {
      mode: "plaintext",
      privacyWarning: "Plain kNN: raw GPS was transmitted to the server. This is the non-private baseline.",
      results,
      latencyMs: elapsed,
      merkleRoot: this.merkleRoot,
    };
  }

  // ── Candidate discovery (Phase 4) ───────────────────────────────────────
  //
  // ROOT CAUSE this replaces: buildSecureCircuit() used to take
  // `pois.filter(category).slice(0, MAX_SECURE_POIS)` — the first N POIs in
  // whatever arbitrary order OSM/Overpass happened to return them in, with
  // ZERO relationship to the querying user's location. A user in RR Nagar
  // would get whichever hospitals happened to be first in that order (e.g.
  // clustered near Bellandur), and a genuinely closer hospital would simply
  // never be considered if it wasn't in the first N.
  //
  // Fix: this method ranks the FULL cached dataset by distance from a
  // location and returns the nearest `limit` matching candidates. It reuses
  // plainKNN() — this is exactly a "nearest POIs to a point" query, just
  // with a coarse point instead of the user's exact one.
  //
  // PRIVACY BOUNDARY CHANGE — read carefully:
  //   This method DOES receive a location. It is intentionally coarsened —
  //   server-side, regardless of what precision the client sent — to a
  //   ~1km × 1km grid cell (CANDIDATE_COARSEN_DECIMALS = 2 decimal
  //   places). This reveals the user's approximate ~1km area to this
  //   server for the sole purpose of candidate selection.
  //   It does NOT reveal the user's exact coordinates, and the secure
  //   computation (buildSecureCircuit / resolveSecureQuery below) still
  //   never receives ANY location data, coarse or exact — it only receives
  //   the resulting candidate ids. The claim "the secure computation never
  //   sees your location" remains true; the claim "the server never learns
  //   anything about your location" does NOT — it learns your ~1km cell
  //   during candidate discovery. Document this honestly in the UI.
  //
  // @param {number} rawLat, rawLng - client-supplied location (will be
  //        coarsened here regardless of the precision actually sent)
  // @param {string[]} categories
  // @param {number} limit
  // @returns {{ candidateIds, candidates, coarseLat, coarseLng, precisionDeg }}
  getLocationAwareCandidates(rawLat, rawLng, categories = null, limit = MAX_SECURE_POIS) {
    const coarseLat = coarsen(rawLat);
    const coarseLng = coarsen(rawLng);

    const nearest = plainKNN(
      { latitude: coarseLat, longitude: coarseLng },
      this.pois,
      limit,
      categories
    );

    console.log(
      `[VEIL] Candidate discovery near (${coarseLat}, ${coarseLng}) [coarsened to ${CANDIDATE_COARSEN_DECIMALS}dp] — ` +
      `${nearest.length} candidates, categories=${categories ? categories.join(",") : "all"}`
    );

    return {
      candidateIds: nearest.map((p) => p.id),
      // Public POI info only (name/category/location of real-world places —
      // not sensitive). Included so the UI can show "searching near you"
      // context without a second round trip.
      candidates: nearest.map((p) => ({
        id: p.id, name: p.name, category: p.category,
        latitude: p.latitude, longitude: p.longitude,
        distMetres: p.distMetres,
      })),
      coarseLat,
      coarseLng,
      precisionDeg: 10 ** -CANDIDATE_COARSEN_DECIMALS,
    };
  }

  // ── SECURE path: Step 1 — Garble circuit (NO coordinates received) ────────

  /**
   * Build and garble the kNN circuit for the given category + k.
   * Does NOT accept lat/lng. Does NOT log any user location.
   *
   * @param {number}   k            - number of neighbours
   * @param {string[]} categories   - category filter (null = all)
   * @param {string[]} [candidateIds] - Phase 4: pre-selected, location-aware
   *        candidate ids from getLocationAwareCandidates(). When omitted,
   *        falls back to the old array-order slice (kept only for backward
   *        compatibility / callers that haven't run candidate discovery —
   *        e.g. "browse all" with no location available).
   * @returns {{ bundle, internalGC, dataset, garbleMs }}
   */
  buildSecureCircuit(k = 5, categories = null, candidateIds = null) {
    let dataset;
    if (candidateIds && candidateIds.length > 0) {
      const idSet = new Set(candidateIds);
      dataset = this.pois.filter((p) => idSet.has(p.id)).slice(0, MAX_SECURE_POIS);
    } else {
      dataset = (categories
        ? this.pois.filter((p) => categories.includes(p.category))
        : this.pois
      ).slice(0, MAX_SECURE_POIS);
    }

    if (dataset.length === 0) {
      throw new Error("No POIs match the requested categories.");
    }

    console.log(
      `[VEIL] Garbling circuit: ${dataset.length} POIs, k=${k} — no coordinates received` +
      (candidateIds ? " (location-aware candidate set)" : " (fallback: unordered slice)")
    );

    const t0 = performance.now();
    const internalGC = garbleCircuit(dataset, k);
    const garbleMs = (performance.now() - t0).toFixed(2);

    console.log(
      `[VEIL] Circuit garbled in ${garbleMs}ms — ${internalGC.numGates} gates`
    );

    const bundle = buildClientBundle(internalGC);

    return {
      bundle,       // safe to send to client
      internalGC,   // kept server-side in session store
      dataset,      // POI subset used in this circuit
      garbleMs,
    };
  }

  // ── SECURE path: Step 2 — Resolve POI ids (NO coordinates received) ───────

  /**
   * Given the k POI ids returned by the client's circuit evaluation,
   * return full POI metadata and Merkle proofs.
   *
   * Does NOT accept lat/lng. Does NOT log any user location.
   * The server learns which POIs are nearest — this is the inherent
   * output of any useful location search. It does NOT learn the
   * client's exact coordinates.
   *
   * @param {object[]} dataset   - POI subset from buildSecureCircuit
   * @param {string[]} resultIds - k POI ids from client's circuit evaluation
   * @returns {{ pois, merkleProofs, verificationResult }}
   */
  resolveSecureQuery(dataset, resultIds) {
    const datasetMap = new Map(dataset.map((p) => [p.id, p]));
    const validIds = (resultIds || []).filter((id) => datasetMap.has(id));

    if (validIds.length === 0) {
      console.warn("[VEIL] resolveSecureQuery: no valid result ids");
      return { pois: [], merkleProofs: [], verificationResult: { valid: false, details: [] } };
    }

    const pois = validIds.map((id) => datasetMap.get(id));

    // Merkle proofs — prove each returned POI is in the committed dataset
    let merkleProofs = [];
    let verificationResult = { valid: false, details: [] };

    try {
      const committedIds = validIds.filter((id) => this.commitment.poiIndex.has(id));
      if (committedIds.length > 0) {
        merkleProofs = generateResultProofs(committedIds, this.commitment);
        const resultPois = committedIds.map((id) => this.pois.find((p) => p.id === id)).filter(Boolean);
        verificationResult = verifyResults(merkleProofs, resultPois, this.merkleRoot);
      }
    } catch (err) {
      console.warn("[VEIL] Merkle proof error:", err.message);
    }

    return { pois, merkleProofs, verificationResult };
  }

  // ── Complexity analysis ────────────────────────────────────────────────────

  complexityAnalysis(k = 5) {
    return complexityReport(this.pois.length, k, COORD_BITS);
  }
}
