/**
 * VEIL — Express API Server
 *
 * Privacy boundary summary:
 *
 *   POST /api/knn/plain    ← receives lat/lng (NON-PRIVATE baseline)
 *   POST /api/gc/init      ← receives {k, categories} ONLY — no coordinates
 *   POST /api/gc/resolve   ← receives {sessionId, resultIds} ONLY — no coordinates
 *   POST /api/knn/secure   ← DEPRECATED: returns 410 explaining migration
 *
 * The server NEVER logs raw user GPS in secure mode.
 * The server NEVER stores raw user GPS.
 */

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { fetchPOIs, BENGALURU_BBOX } from "./osm/fetcher.js";
import { VEILSession } from "./crypto/veil.js";
import { verifyProof } from "./crypto/merkle/merkleTree.js";
import { benchmarkOT } from "./crypto/ot/obliviousTransfer.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ─────────────────────────────────────────────────────────────────────────────
// SERVER STATE
// ─────────────────────────────────────────────────────────────────────────────

let veilSession = null;
let datasetLoadedAt = null;
const DATASET_TTL_MS = 30 * 60 * 1000;

// GC Session store — maps sessionId → { internalGC, dataset, createdAt }
// Sessions expire after 5 minutes to prevent memory growth.
const gcSessions = new Map();
const GC_SESSION_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of gcSessions.entries()) {
    if (now - s.createdAt > GC_SESSION_TTL_MS) {
      gcSessions.delete(id);
    }
  }
  if (gcSessions.size > 0) {
    console.log(`[GC] ${gcSessions.size} active session(s)`);
  }
}, 60_000);

async function ensureSession(categories = ["hospital", "restaurant", "pharmacy", "cafe"]) {
  const now = Date.now();
  if (veilSession && datasetLoadedAt && now - datasetLoadedAt < DATASET_TTL_MS) {
    return veilSession;
  }
  console.log("[Server] Fetching fresh POI dataset from OpenStreetMap...");
  let pois;
  try {
    pois = await fetchPOIs(categories, BENGALURU_BBOX, 500);
  } catch (fetchErr) {
    // Distinguish "OSM/Overpass unreachable" from other errors so route
    // handlers can return a specific, user-friendly 503 instead of a bare 500.
    const err = new Error(
      "Live OpenStreetMap data is temporarily unavailable. Please try again shortly."
    );
    err.code = "DATASET_UNAVAILABLE";
    err.cause = fetchErr.message;
    throw err;
  }
  if (pois.length === 0) {
    const err = new Error("OpenStreetMap returned no POIs for the requested area/categories.");
    err.code = "DATASET_EMPTY";
    throw err;
  }
  veilSession = new VEILSession(pois);
  datasetLoadedAt = now;
  return veilSession;
}

// Shared error responder: maps a thrown error to an HTTP status + a
// user-safe message. Never leaks stack traces to the client; full detail
// (including the original cause) still goes to the server console.
function sendError(res, routeLabel, err) {
  console.error(`[${routeLabel}]`, err.message, err.cause ? `(cause: ${err.cause})` : "");
  const statusByCode = { DATASET_UNAVAILABLE: 503, DATASET_EMPTY: 503 };
  const status = statusByCode[err.code] || 500;
  res.status(status).json({
    success: false,
    error: err.message,
    code: err.code || "INTERNAL_ERROR",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    // PRIVACY: Never log request bodies for secure endpoints
    const isSafe = !req.path.includes("/gc/");
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)${isSafe ? "" : " [coordinates not logged]"}`
    );
  });
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.1.0",
    system: "VEIL — Privacy-Preserving kNN",
    privacyProtocol: "Garbled Circuit + OT (simulated) + Merkle",
    session: veilSession
      ? {
          ready: true,
          poiCount: veilSession.pois.length,
          merkleRoot: veilSession.merkleRoot.slice(0, 16) + "...",
          loadedAt: new Date(datasetLoadedAt).toISOString(),
          activeSessions: gcSessions.size,
        }
      : { ready: false },
    endpoints: {
      plainKNN: "POST /api/knn/plain  (non-private baseline — sends coordinates)",
      secureInit: "POST /api/gc/init   (secure — no coordinates)",
      secureResolve: "POST /api/gc/resolve (secure — no coordinates)",
    },
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dataset
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/dataset", async (req, res) => {
  try {
    const categories = req.query.categories
      ? req.query.categories.split(",").map((c) => c.trim())
      : ["hospital", "restaurant", "pharmacy", "cafe"];
    if (req.query.refresh === "true") veilSession = null;

    const session = await ensureSession(categories);
    const grouped = {};
    for (const poi of session.pois) {
      if (!grouped[poi.category]) grouped[poi.category] = [];
      grouped[poi.category].push(poi);
    }

    res.json({
      success: true,
      total: session.pois.length,
      merkleRoot: session.merkleRoot,
      loadedAt: new Date(datasetLoadedAt).toISOString(),
      categories: Object.fromEntries(Object.entries(grouped).map(([cat, p]) => [cat, p.length])),
      pois: session.pois,
    });
  } catch (err) {
    sendError(res, "/api/dataset", err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/knn/plain  — NON-PRIVATE BASELINE
// Receives lat/lng in plaintext. Clearly documented as non-private.
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/knn/plain", async (req, res) => {
  try {
    const { latitude, longitude, k = 5, categories = null } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: "latitude and longitude required" });
    }

    // Plain mode: server DOES receive coordinates — this is the non-private baseline
    console.log(`[Plain kNN] Query received — k=${k} (coordinates received by server in plain mode)`);

    const session = await ensureSession();
    const result = session.plainQuery(latitude, longitude, k, categories);
    res.json({ success: true, query: { latitude, longitude, k }, ...result });
  } catch (err) {
    sendError(res, "/api/knn/plain", err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/candidates  — PHASE 4: LOCATION-AWARE CANDIDATE DISCOVERY
//
// Accepts: { latitude, longitude, categories, limit }
// This endpoint DOES receive a location — that is a deliberate, documented
// trust-boundary change from the pure secure path below. The server
// coarsens whatever precision it receives down to a ~1km grid cell
// (see CANDIDATE_COARSEN_DECIMALS in crypto/veil.js) BEFORE using it for
// anything, and never stores or logs the raw value it was sent.
//
// This is NOT the secure computation. It exists solely to pick a
// geographically relevant candidate set — replacing the old behaviour of
// slicing the first N POIs in arbitrary dataset order regardless of where
// the user actually is. The candidate ids this returns are then passed to
// /api/gc/init, which still never receives any location, coarse or exact.
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/candidates", async (req, res) => {
  try {
    const { latitude, longitude, categories = null, limit } = req.body;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return res.status(400).json({
        error: "latitude and longitude (numbers) are required for candidate discovery.",
        code: "LOCATION_REQUIRED",
      });
    }

    const session = await ensureSession();
    const { candidateIds, candidates, coarseLat, coarseLng, precisionDeg } =
      session.getLocationAwareCandidates(latitude, longitude, categories, limit || undefined);

    res.json({
      success: true,
      candidateIds,
      candidates,
      coarsenedTo: { latitude: coarseLat, longitude: coarseLng, precisionDeg },
      privacyNote:
        `Your location was coarsened to a ~${(precisionDeg * 111).toFixed(1)}km grid cell ` +
        `before being used. The server does not store or log your exact coordinates. ` +
        `The secure computation (/api/gc/init, /api/gc/resolve) receives none of this — ` +
        `only the resulting candidate ids.`,
    });
  } catch (err) {
    sendError(res, "/api/candidates", err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gc/init  — SECURE PATH STEP 1
// Accepts: { k, categories, candidateIds }
// DOES NOT accept latitude or longitude.
// Returns: garbled circuit bundle (safe for client).
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/gc/init", async (req, res) => {
  try {
    const { k = 5, categories = null, candidateIds = null } = req.body;

    // Explicitly reject if someone tries to send coordinates
    if (req.body.latitude !== undefined || req.body.longitude !== undefined) {
      return res.status(400).json({
        error: "Secure endpoint /api/gc/init must not receive coordinates. " +
               "Encode your location client-side and use the OT protocol.",
        code: "COORDINATES_REJECTED",
      });
    }

    // No coordinate logging — server does not know (and must not know) the client's location
    console.log(`[GC init] Building circuit: k=${k} categories=${JSON.stringify(categories)}` +
      (candidateIds ? ` candidateIds=${candidateIds.length}` : ""));

    const session = await ensureSession();
    const { bundle, internalGC, dataset, garbleMs } =
      session.buildSecureCircuit(k, categories, candidateIds);

    const sessionId = crypto.randomUUID();
    gcSessions.set(sessionId, {
      internalGC,
      dataset,
      createdAt: Date.now(),
    });

    res.json({
      success: true,
      sessionId,
      ...bundle,                        // garbledGates, clientWirePairs, etc.
      merkleRoot: session.merkleRoot,
      garbleMs,
      privacyNote: "No coordinates were received. Client evaluates this circuit locally.",
    });
  } catch (err) {
    sendError(res, "/api/gc/init", err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gc/resolve  — SECURE PATH STEP 2
// Accepts: { sessionId, resultIds: string[] }
// DOES NOT accept latitude or longitude.
// Returns: enriched POI data + Merkle proofs.
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/gc/resolve", async (req, res) => {
  try {
    const { sessionId, resultIds } = req.body;

    if (req.body.latitude !== undefined || req.body.longitude !== undefined) {
      return res.status(400).json({
        error: "Secure endpoint /api/gc/resolve must not receive coordinates.",
        code: "COORDINATES_REJECTED",
      });
    }

    if (!sessionId || !Array.isArray(resultIds)) {
      return res.status(400).json({ error: "sessionId and resultIds[] required" });
    }

    const gcSession = gcSessions.get(sessionId);
    if (!gcSession) {
      return res.status(404).json({
        error: "Session expired or not found. Please re-run the secure query.",
        code: "SESSION_NOT_FOUND",
      });
    }

    // No coordinate logging
    console.log(`[GC resolve] Session ${sessionId.slice(0, 8)}... — ${resultIds.length} result ids`);

    const vSession = await ensureSession();
    const result = vSession.resolveSecureQuery(gcSession.dataset, resultIds);

    // One-shot session — delete after use
    gcSessions.delete(sessionId);

    res.json({
      success: true,
      ...result,
      privacyNote: "Server learned which POIs were returned. Server did NOT learn the client's coordinates.",
    });
  } catch (err) {
    sendError(res, "/api/gc/resolve", err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/knn/secure  — DEPRECATED
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/knn/secure", (req, res) => {
  res.status(410).json({
    success: false,
    error:
      "POST /api/knn/secure has been removed. " +
      "It received raw coordinates, which violated VEIL's privacy guarantee. " +
      "Use the split protocol: POST /api/gc/init then POST /api/gc/resolve.",
    migration: {
      step1: "POST /api/gc/init  with { k, categories } — no coordinates",
      step2: "Evaluate garbled circuit client-side (gcProtocol.js)",
      step3: "POST /api/gc/resolve  with { sessionId, resultIds }",
    },
    code: "DEPRECATED",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REMAINING UTILITY ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/complexity", async (req, res) => {
  try {
    const k = parseInt(req.query.k) || 5;
    const session = await ensureSession();
    res.json({ success: true, report: session.complexityAnalysis(k) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/verify", (req, res) => {
  try {
    const { leafHash, proof, root } = req.body;
    if (!leafHash || !proof || !root) {
      return res.status(400).json({ error: "leafHash, proof, root required" });
    }
    const valid = verifyProof(leafHash, proof, root);
    res.json({
      valid,
      message: valid
        ? "✓ Proof verified — this POI is in the committed dataset."
        : "✗ Proof invalid — this POI may not be in the committed dataset.",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/ot/benchmark", async (req, res) => {
  try {
    const m = parseInt(req.query.m) || 64;
    const result = await benchmarkOT(m);
    res.json({ success: true, benchmark: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/benchmark  — PHASE 5: PLAIN vs SECURE kNN BENCHMARK
//
// A BENCHMARKING/EVALUATION UTILITY — deliberately separate from the live
// query path. The app's actual search flow (App.jsx / gcProtocol.js) never
// calls this endpoint and is completely unaffected by it; it still uses
// /api/candidates → /api/gc/init → LOCAL browser evaluation → /api/gc/resolve
// exactly as before.
//
// Sending raw coordinates here is a deliberate exception, same rationale as
// the existing /api/knn/plain baseline and /api/ot/benchmark above: this
// endpoint exists to produce real, reproducible timing numbers for the
// project report, not to serve a real user's private query.
//
// It reuses the EXISTING VEILSession methods (getLocationAwareCandidates,
// plainQuery, buildSecureCircuit) rather than re-implementing any ranking or
// garbling logic here.
//
// IMPORTANT — what this endpoint deliberately does NOT measure: the client's
// secure circuit EVALUATION time (SubtleCrypto AES-CBC in the browser).
// Measuring that here would require either (a) the server evaluating its
// own garbled circuit, which trivially defeats the privacy property being
// benchmarked since the server already has the coordinates from this
// request, or (b) a real browser. For a genuine, deterministic, full-pipeline
// number — candidate discovery + garbling + an independent client-side
// evaluation + resolve + Merkle verification — run `node test/benchmark.mjs`
// (Node + WebCrypto, same technique as test/run_tests.mjs), or read the
// in-app timing breakdown after a real browser query.
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/benchmark", async (req, res) => {
  try {
    const { latitude, longitude, k = 5, categories = null } = req.body;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return res.status(400).json({
        error: "latitude and longitude (numbers) are required for benchmarking.",
        code: "LOCATION_REQUIRED",
      });
    }

    const session = await ensureSession();
    const filteredDatasetSize = (categories
      ? session.pois.filter((p) => categories.includes(p.category))
      : session.pois
    ).length;

    let t = performance.now();
    const candidateResult = session.getLocationAwareCandidates(latitude, longitude, categories);
    const candidateDiscoveryMs = +(performance.now() - t).toFixed(2);

    t = performance.now();
    const plainResult = session.plainQuery(latitude, longitude, k, categories);
    const plainQueryMs = +(performance.now() - t).toFixed(2);

    t = performance.now();
    const { dataset, garbleMs, bundle } =
      session.buildSecureCircuit(k, categories, candidateResult.candidateIds);
    const circuitBuildRoundtripMs = +(performance.now() - t).toFixed(2);

    res.json({
      success: true,
      query: { k, categories },
      workloadNote:
        `Plain kNN searched the FULL category-filtered dataset (${filteredDatasetSize} POIs). ` +
        `Secure VEIL kNN computed over the location-aware candidate set only (${dataset.length} POIs). ` +
        `These are NOT equal-sized workloads — see README "Benchmark Methodology" before comparing ` +
        `the two timings directly.`,
      candidateDiscovery: {
        timeMs: candidateDiscoveryMs,
        candidateCount: candidateResult.candidateIds.length,
        coarsenedTo: { latitude: candidateResult.coarseLat, longitude: candidateResult.coarseLng },
      },
      plainKNN: {
        timeMs: plainQueryMs,
        internalLatencyMs: parseFloat(plainResult.latencyMs),
        datasetSize: filteredDatasetSize,
        resultIds: plainResult.results.map((p) => p.id),
      },
      secureCircuitGarbling: {
        timeMs: parseFloat(garbleMs),
        roundtripMs: circuitBuildRoundtripMs,
        candidateSetSize: dataset.length,
        gateCount: bundle.numGates,
      },
      note:
        "Secure circuit EVALUATION time (browser SubtleCrypto AES-CBC) is intentionally not " +
        "measured here — see the comment above this route in server.js for why, and use " +
        "`node test/benchmark.mjs` or the in-app timing breakdown for that number.",
    });
  } catch (err) {
    sendError(res, "/api/benchmark", err);
  }
});

app.get("/api/poi/:id", async (req, res) => {
  try {
    const session = await ensureSession();
    const poi = session.pois.find((p) => p.id === req.params.id);
    if (!poi) return res.status(404).json({ error: "POI not found" });
    res.json({ success: true, poi });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🛡️  VEIL Backend v1.1 — http://localhost:${PORT}`);
  console.log(`   Privacy: Garbled Circuit + OT (simulated) + Merkle verification`);
  console.log(`\n   Secure endpoints (no coordinates accepted):`);
  console.log(`   POST /api/gc/init     ← garble circuit`);
  console.log(`   POST /api/gc/resolve  ← resolve result ids`);
  console.log(`\n   Non-private baseline:`);
  console.log(`   POST /api/knn/plain   ← sends coordinates to server\n`);

  try {
    await ensureSession();
  } catch (err) {
    console.warn("[Server] Pre-fetch failed (will retry on first request):", err.message);
  }
});

export default app;
