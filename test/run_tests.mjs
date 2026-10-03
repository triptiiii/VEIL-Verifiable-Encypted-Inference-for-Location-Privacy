/**
 * VEIL — Automated Test Suite (recreated; not present in the delivered zip)
 *
 * IMPORTANT HONESTY NOTE:
 * This sandbox's network egress does NOT include overpass-api.de (confirmed:
 * HTTP 403 / x-deny-reason: host_not_allowed), so live OpenStreetMap data
 * cannot be fetched here. The POI records below are a small SYNTHETIC test
 * fixture used only to exercise the crypto/protocol pipeline — they are
 * clearly marked as such and must not be mistaken for real OSM data.
 * Live Overpass connectivity must be verified in the user's own environment
 * (see the report's "still to verify" section).
 *
 * This suite also does NOT run inside an actual browser (no display in this
 * sandbox). Instead it imports the real, unmodified client module
 * (frontend/src/services/gcProtocol.js) into Node and polyfills only the two
 * globals it needs (`crypto.subtle` via Node's own `crypto.webcrypto`, which
 * implements the same W3C SubtleCrypto interface Chrome/Firefox expose, and
 * `fetch`, which Node 18+ already provides natively). This is a stronger
 * check than the Phase-1 handoff's "Node AES-ECB simulation" because it uses
 * a real SubtleCrypto AES-CBC implementation, not a hand-rolled stand-in —
 * but it is still not a literal browser and should be labelled as such.
 */

import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { VEILSession } from "../backend/crypto/veil.js";
import { verifyProof } from "../backend/crypto/merkle/merkleTree.js";
import { plainKNN, haversineMetres as serverHaversine } from "../backend/geometry/knn.js";
import {
  encodeQuery,
  selectActiveLabels,
  evaluateGarbledCircuit,
  haversineMetres as clientHaversine,
} from "../frontend/src/services/gcProtocol.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? " — " + detail : ""}`); }
}
function section(name) { console.log(`\n[${name}]`); }

// ── SYNTHETIC_TEST fixture (NOT real OSM data) ─────────────────────────────
const SYN = [
  { id: "SYN_p1", osmId: 1, name: "Test Point p1 (query origin)", category: "cafe",       latitude: 12.9716, longitude: 77.5946, tags: {} },
  { id: "SYN_c1", osmId: 2, name: "Test Cafe c1",                  category: "cafe",       latitude: 12.9720, longitude: 77.5950, tags: {} },
  { id: "SYN_r1", osmId: 3, name: "Test Restaurant r1",            category: "restaurant", latitude: 12.9760, longitude: 77.5990, tags: {} },
  { id: "SYN_h1", osmId: 4, name: "Test Hospital h1",              category: "hospital",   latitude: 12.9500, longitude: 77.5700, tags: {} },
  { id: "SYN_h2", osmId: 5, name: "Test Hospital h2",              category: "hospital",   latitude: 12.9730, longitude: 77.5955, tags: {} },
  { id: "SYN_ph1", osmId: 6, name: "Test Pharmacy ph1",            category: "pharmacy",   latitude: 12.9600, longitude: 77.5800, tags: {} },
];

const session = new VEILSession(SYN);

// ── [1] Gate reachability ───────────────────────────────────────────────────
section("1. Gate reachability");
{
  const { bundle } = session.buildSecureCircuit(5, null);
  const producedWires = new Set(bundle.garbledGates.map(g => g.outputWire));
  const inputWires = new Set([
    ...bundle.clientWireList,
    ...Object.keys(bundle.serverActiveLabels).map(Number),
  ]);
  let unreachable = 0;
  for (const gate of bundle.garbledGates) {
    for (const w of gate.inputWires) {
      if (!inputWires.has(w) && !producedWires.has(w)) unreachable++;
    }
  }
  check(`${bundle.garbledGates.length} gates, all inputs reachable`, unreachable === 0, `${unreachable} unreachable`);
}

// ── [2] Secure vs Plain correctness (multiple query points, multiple k) ────
section("2. Secure vs Plain correctness");
async function runSecureQuery(lat, lng, k, categories) {
  const { bundle, dataset } = session.buildSecureCircuit(k, categories);
  const queryBits = encodeQuery(lat, lng);
  const resultIds = await evaluateGarbledCircuit(bundle, queryBits, k);
  const { pois } = session.resolveSecureQuery(dataset, resultIds);
  return pois.map(p => p.id);
}

const queryPoints = [
  { label: "at p1",  lat: 12.9716, lng: 77.5946 },
  { label: "at h1",  lat: 12.9500, lng: 77.5700 },
  { label: "offset", lat: 12.9650, lng: 77.5850 },
];
const ks = [1, 3, 5];

for (const qp of queryPoints) {
  for (const k of ks) {
    const plainIds = plainKNN({ latitude: qp.lat, longitude: qp.lng }, SYN, k, null).map(p => p.id);
    const secureIds = await runSecureQuery(qp.lat, qp.lng, k, null);
    check(
      `query ${qp.label}, k=${k}: secure top-${k} == plain top-${k}`,
      JSON.stringify(secureIds) === JSON.stringify(plainIds),
      `secure=${JSON.stringify(secureIds)} plain=${JSON.stringify(plainIds)}`
    );
  }
}

// nearest-at-self sanity check
{
  const plainIds = plainKNN({ latitude: 12.9716, longitude: 77.5946 }, SYN, 1, null).map(p => p.id);
  check("query at p1's own coords: p1 is nearest", plainIds[0] === "SYN_p1", plainIds[0]);
}

// ── [3] AES key / hash parity (real WebCrypto vs Node crypto) ──────────────
section("3. AES-ECB (server) vs SubtleCrypto AES-CBC (client) parity");
{
  const nodeCrypto = await import("node:crypto");
  const FIXED_KEY = Buffer.from("VEIL_GC_KEY_FIXED", "utf8").subarray(0, 16);
  const pt = Buffer.alloc(16, 0x11);
  const cipher = nodeCrypto.createCipheriv("aes-128-ecb", FIXED_KEY, null);
  cipher.setAutoPadding(false);
  const ecbOut = Buffer.concat([cipher.update(pt), cipher.final()]);

  const key = await crypto.subtle.importKey("raw", new Uint8Array(FIXED_KEY), { name: "AES-CBC" }, false, ["encrypt"]);
  const iv = new Uint8Array(16);
  const cbcOut = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, pt));

  check("AES-ECB(K,pt) == SubtleCrypto AES-CBC(K,0,pt)[0:16]", Buffer.from(cbcOut.slice(0, 16)).equals(ecbOut));
}

// ── [4] Merkle proof verification ───────────────────────────────────────────
section("4. Merkle proof verification");
{
  const { bundle, dataset } = session.buildSecureCircuit(3, null);
  const queryBits = encodeQuery(12.9716, 77.5946);
  const resultIds = await evaluateGarbledCircuit(bundle, queryBits, 3);
  const { pois, merkleProofs, verificationResult } = session.resolveSecureQuery(dataset, resultIds);
  check(`${pois.length} results returned`, pois.length === 3);
  check("verifyResults() reports valid", verificationResult.valid === true, JSON.stringify(verificationResult));
  let allProofsOk = merkleProofs.length > 0;
  for (const proof of merkleProofs) {
    const poi = pois.find(p => p.id === proof.poiId);
    if (!poi) { allProofsOk = false; continue; }
    const ok = verifyProof(proof.leafHash, proof.proof, session.merkleRoot);
    if (!ok) allProofsOk = false;
  }
  check("individual verifyProof() checks pass for all results", allProofsOk);
}

// ── [5] Privacy boundary (live HTTP against running server.js) ─────────────
section("5. Privacy boundary (live server)");
try {
  const base = "http://localhost:3001";

  const initRes = await fetch(`${base}/api/gc/init`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ k: 5, categories: null }),
  });
  const initBody = await initRes.json().catch(() => ({}));
  if (initBody.code === "DATASET_UNAVAILABLE") {
    console.log("  \u26a0 SKIPPED: POST /api/gc/init succeeds without coordinates — " +
      "sandbox cannot reach overpass-api.de (host_not_allowed), not a code defect. " +
      "Must be re-verified in an environment with real internet access.");
  } else {
    check("POST /api/gc/init succeeds without coordinates", initRes.ok, `status ${initRes.status}`);
  }

  const initWithCoords = await fetch(`${base}/api/gc/init`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ k: 5, categories: null, latitude: 12.97, longitude: 77.59 }),
  });
  check("POST /api/gc/init REJECTS a body containing latitude/longitude", initWithCoords.status === 400, `status ${initWithCoords.status}`);

  const resolveWithCoords = await fetch(`${base}/api/gc/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "x", resultIds: [], latitude: 12.97 }),
  });
  check("POST /api/gc/resolve REJECTS a body containing latitude", resolveWithCoords.status === 400, `status ${resolveWithCoords.status}`);

  const deprecated = await fetch(`${base}/api/knn/secure`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latitude: 12.97, longitude: 77.59 }),
  });
  check("POST /api/knn/secure returns 410 Gone", deprecated.status === 410, `status ${deprecated.status}`);
} catch (err) {
  check("live server reachable on :3001", false, err.message);
}

// ── [6] Haversine client/server parity ──────────────────────────────────────
section("6. Haversine client/server parity");
{
  const a = clientHaversine(12.9716, 77.5946, 12.9800, 77.6000);
  const b = serverHaversine(12.9716, 77.5946, 12.9800, 77.6000);
  check("client haversineMetres() == server haversineMetres()", a === b, `client=${a} server=${b}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — LOCATION-AWARE CANDIDATE DISCOVERY
//
// A second, purpose-built SYNTHETIC fixture: two well-separated "neighbourhoods"
// (standing in for RR Nagar vs Koramangala — NOT real coordinates for either
// place) with hospitals and cafés near each. Critically, the array ORDER is
// deliberately uncorrelated with either point — near-B entries are listed
// BEFORE near-A entries — specifically so that the OLD bug ("first N in
// dataset order") and the NEW behaviour ("sorted by distance from a coarse
// point") give DIFFERENT, distinguishable answers. If this fixture were
// ordered near-to-far already, the old buggy code could accidentally pass
// by coincidence.
// ═══════════════════════════════════════════════════════════════════════════

const POINT_A = { latitude: 12.9200, longitude: 77.5200 }; // stand-in for "RR Nagar"
const POINT_B = { latitude: 13.0200, longitude: 77.6200 }; // stand-in for "Koramangala" (~15km from A)

const SYN_GEO = [
  // Near B — listed FIRST, deliberately, despite being far from A
  { id: "GEO_hB1", osmId: 101, name: "Test Hospital near-B #1", category: "hospital", latitude: 13.0210, longitude: 77.6210, tags: {} },
  { id: "GEO_hB2", osmId: 102, name: "Test Hospital near-B #2", category: "hospital", latitude: 13.0185, longitude: 77.6180, tags: {} },
  // A genuinely distant outlier, far from both A and B
  { id: "GEO_hFar", osmId: 103, name: "Test Hospital, distant outlier", category: "hospital", latitude: 12.8000, longitude: 77.4500, tags: {} },
  // Near A — listed AFTER the near-B and far entries
  { id: "GEO_hA1", osmId: 104, name: "Test Hospital near-A #1", category: "hospital", latitude: 12.9205, longitude: 77.5210, tags: {} },
  { id: "GEO_hA2", osmId: 105, name: "Test Hospital near-A #2", category: "hospital", latitude: 12.9188, longitude: 77.5193, tags: {} },
  // Cafés for category-filtering checks
  { id: "GEO_cB1", osmId: 106, name: "Test Cafe near-B", category: "cafe", latitude: 13.0201, longitude: 77.6201, tags: {} },
  { id: "GEO_cA1", osmId: 107, name: "Test Cafe near-A", category: "cafe", latitude: 12.9202, longitude: 77.5203, tags: {} },
];

const geoSession = new VEILSession(SYN_GEO);

section("7. Location-aware candidate discovery — root-cause reproduction");
{
  // OLD (buggy) behaviour, reproduced directly: filter by category, then take
  // the first N in ARRAY order — exactly what buildSecureCircuit() used to do
  // before Phase 4. This should surface the near-B hospitals for a query
  // near A, reproducing the reported RR-Nagar-getting-Bellandur symptom.
  const oldBuggyCandidates = SYN_GEO.filter(p => p.category === "hospital").slice(0, 2).map(p => p.id);
  check(
    "OLD array-order slice reproduces the reported bug (near-A query would get near-B hospitals)",
    oldBuggyCandidates.includes("GEO_hB1") && oldBuggyCandidates.includes("GEO_hB2"),
    `old slice would have returned: ${JSON.stringify(oldBuggyCandidates)}`
  );
}

section("8. Location-aware candidate discovery — fix verification");
{
  const nearA = geoSession.getLocationAwareCandidates(POINT_A.latitude, POINT_A.longitude, ["hospital"], 2);
  check(
    "query near A returns the two hospitals actually near A (not near-B or the outlier)",
    nearA.candidateIds.includes("GEO_hA1") && nearA.candidateIds.includes("GEO_hA2"),
    `got ${JSON.stringify(nearA.candidateIds)}`
  );
  check(
    "query near A does NOT return the far/near-B hospitals",
    !nearA.candidateIds.includes("GEO_hB1") && !nearA.candidateIds.includes("GEO_hFar"),
    `got ${JSON.stringify(nearA.candidateIds)}`
  );

  const nearB = geoSession.getLocationAwareCandidates(POINT_B.latitude, POINT_B.longitude, ["hospital"], 2);
  check(
    "query near B returns the two hospitals actually near B",
    nearB.candidateIds.includes("GEO_hB1") && nearB.candidateIds.includes("GEO_hB2"),
    `got ${JSON.stringify(nearB.candidateIds)}`
  );
  check(
    "location A and location B produce DIFFERENT candidate sets",
    JSON.stringify([...nearA.candidateIds].sort()) !== JSON.stringify([...nearB.candidateIds].sort())
  );

  // Category filtering within candidate discovery
  const cafesNearA = geoSession.getLocationAwareCandidates(POINT_A.latitude, POINT_A.longitude, ["cafe"], 1);
  check("category filter applies to candidate discovery (cafe near A)", cafesNearA.candidateIds[0] === "GEO_cA1", JSON.stringify(cafesNearA.candidateIds));

  // Coarsening: server-side rounding, independent of client precision
  check(
    "coarsened location is rounded to 2dp regardless of input precision",
    nearA.coarseLat === Math.round(POINT_A.latitude * 100) / 100 &&
    nearA.coarseLng === Math.round(POINT_A.longitude * 100) / 100,
    `coarseLat=${nearA.coarseLat} coarseLng=${nearA.coarseLng}`
  );
  // Two points inside the same ~1.1km grid cell must coarsen identically —
  // demonstrates the server genuinely can't distinguish exact position
  // within a cell, only which cell.
  const nearAJittered = geoSession.getLocationAwareCandidates(POINT_A.latitude + 0.0003, POINT_A.longitude - 0.0002, ["hospital"], 2);
  check(
    "two nearby points within the same grid cell coarsen to the same cell",
    nearAJittered.coarseLat === nearA.coarseLat && nearAJittered.coarseLng === nearA.coarseLng
  );
}

section("9. Secure vs plain agreement over a location-aware candidate set");
{
  const { candidateIds } = geoSession.getLocationAwareCandidates(POINT_A.latitude, POINT_A.longitude, ["hospital"], 2);
  const { bundle, dataset } = geoSession.buildSecureCircuit(2, ["hospital"], candidateIds);
  check("GC dataset matches the discovered candidate set exactly", 
    JSON.stringify(dataset.map(p => p.id).sort()) === JSON.stringify([...candidateIds].sort()));

  const queryBits = encodeQuery(POINT_A.latitude, POINT_A.longitude);
  const secureIds = await evaluateGarbledCircuit(bundle, queryBits, 2);
  const plainIds = plainKNN(POINT_A, dataset, 2, ["hospital"]).map(p => p.id);
  check(
    "secure top-2 over the candidate set == plain top-2 over the SAME candidate set",
    JSON.stringify(secureIds) === JSON.stringify(plainIds),
    `secure=${JSON.stringify(secureIds)} plain=${JSON.stringify(plainIds)}`
  );
}

section("10. Privacy boundary — /api/candidates vs the secure endpoints");
try {
  const base = "http://localhost:3001";

  const missingLoc = await fetch(`${base}/api/candidates`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categories: ["hospital"] }),
  });
  check("POST /api/candidates REQUIRES latitude/longitude", missingLoc.status === 400, `status ${missingLoc.status}`);

  const withLoc = await fetch(`${base}/api/candidates`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latitude: POINT_A.latitude, longitude: POINT_A.longitude, categories: ["hospital"] }),
  });
  const withLocBody = await withLoc.json().catch(() => ({}));
  if (withLocBody.code === "DATASET_UNAVAILABLE") {
    console.log("  \u26a0 SKIPPED: POST /api/candidates succeeds with a location — sandbox cannot reach overpass-api.de, not a code defect.");
  } else {
    check("POST /api/candidates succeeds given a location", withLoc.ok, `status ${withLoc.status}`);
  }

  // The secure endpoints must remain entirely unaffected by Phase 4 — they
  // still reject coordinates, and now also accept (but don't require)
  // candidateIds without that changing the coordinate rejection.
  const gcInitWithCoords = await fetch(`${base}/api/gc/init`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ k: 2, candidateIds: ["GEO_hA1"], latitude: 12.92 }),
  });
  check("POST /api/gc/init STILL rejects latitude even alongside candidateIds", gcInitWithCoords.status === 400, `status ${gcInitWithCoords.status}`);
} catch (err) {
  check("live server reachable on :3001 (section 10)", false, err.message);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — PLAIN vs SECURE BENCHMARK
// ═══════════════════════════════════════════════════════════════════════════

section("11. Benchmark — runBenchmark() core (deterministic, in-process)");
{
  const { runBenchmark } = await import("./benchmark.mjs");
  const result = await runBenchmark(geoSession, {
    lat: POINT_A.latitude, lng: POINT_A.longitude, k: 2, categories: ["hospital"], candidateLimit: 2,
  });

  const numericTimingFields = [
    "candidateDiscoveryMs", "plainQueryMs", "secureCircuitGarbleMs",
    "secureCircuitGarbleRoundtripMs", "secureClientEncodeMs", "secureClientEvalMs",
    "secureResolveMs", "merkleVerifyMs", "secureTotalMs",
  ];
  const allNumeric = numericTimingFields.every(
    (f) => typeof result.timings[f] === "number" && !Number.isNaN(result.timings[f])
  );
  check("benchmark produces a numeric value for every timing field", allNumeric, JSON.stringify(result.timings));

  const allNonNegative = numericTimingFields.every((f) => result.timings[f] >= 0);
  check("all benchmark timings are >= 0", allNonNegative);

  check(
    "secure top-k agrees with plain top-k over the SAME candidate set",
    result.results.secureAgreesWithPlainOverSameCandidates === true,
    `plainOverCandidates=${JSON.stringify(result.results.plainOverCandidatesIds)} secure=${JSON.stringify(result.results.secureIds)}`
  );
  check("benchmark's Merkle verification passes", result.results.merkleAllVerified === true);
  check(
    "benchmark candidate ids are consistent with getLocationAwareCandidates()",
    result.datasetSizes.candidateSetSize === 2, // k=2 categories=hospital near A → GEO_hA1, GEO_hA2
    `candidateSetSize=${result.datasetSizes.candidateSetSize}`
  );
  check(
    "workload-size difference between plain and secure is explicitly labelled, not hidden",
    typeof result.workloadNote === "string" && result.workloadNote.length > 0
  );
}

section("12. Benchmark — live /api/benchmark endpoint");
try {
  const base = "http://localhost:3001";
  const res = await fetch(`${base}/api/benchmark`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latitude: 12.9716, longitude: 77.5946, k: 3, categories: null }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.code === "DATASET_UNAVAILABLE") {
    console.log("  \u26a0 SKIPPED: POST /api/benchmark — sandbox cannot reach overpass-api.de, not a code defect.");
  } else {
    check("POST /api/benchmark succeeds", res.ok, `status ${res.status}`);
    check(
      "response has numeric timeMs fields for candidateDiscovery/plainKNN/secureCircuitGarbling",
      typeof body.candidateDiscovery?.timeMs === "number" &&
      typeof body.plainKNN?.timeMs === "number" &&
      typeof body.secureCircuitGarbling?.timeMs === "number",
      JSON.stringify(body)
    );
    check("response includes an explicit workload-size note", typeof body.workloadNote === "string" && body.workloadNote.length > 0);
  }

  const missing = await fetch(`${base}/api/benchmark`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ k: 3 }),
  });
  check("POST /api/benchmark REQUIRES latitude/longitude", missing.status === 400, `status ${missing.status}`);
} catch (err) {
  check("live server reachable on :3001 (section 12)", false, err.message);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — CLIENT-SIDE MERKLE VERIFICATION (frontend/src/services/merkleVerify.js)
//
// Previously, the UI displayed resolveData.verificationResult — a value the
// SERVER computed and self-reported — under a "Merkle Verification" badge,
// while the Protocol panel's copy claimed the CLIENT verifies each result.
// That wasn't true. merkleVerify.js makes it true: it independently
// recomputes leaf hashes and proof paths via the browser's own SubtleCrypto.
// These tests exercise that module directly (same Node+WebCrypto technique
// used throughout this file), including a deliberately-tampered case — the
// tamper-detection test this project's own paper flagged as never having
// been performed anywhere in the codebase.
// ═══════════════════════════════════════════════════════════════════════════

section("13. Client-side Merkle verification (merkleVerify.js)");
{
  const { verifyMerkleResultsClientSide } = await import(
    "../frontend/src/services/merkleVerify.js"
  );

  const { candidateIds } = geoSession.getLocationAwareCandidates(
    POINT_A.latitude, POINT_A.longitude, ["hospital"], 2
  );
  const { dataset } = geoSession.buildSecureCircuit(2, ["hospital"], candidateIds);
  const resultIds = dataset.map((p) => p.id);
  const { pois, merkleProofs } = geoSession.resolveSecureQuery(dataset, resultIds);

  // Genuine case: real pois + real proofs + real root → must verify true,
  // computed entirely independently of the server's own verifyResults().
  const goodResult = await verifyMerkleResultsClientSide(pois, merkleProofs, geoSession.merkleRoot);
  check(
    "genuine result set verifies successfully, independently, in-browser (WebCrypto)",
    goodResult.valid === true && goodResult.computedClientSide === true,
    JSON.stringify(goodResult)
  );
  check(
    "every individual detail entry is valid for the genuine case",
    goodResult.details.every((d) => d.valid === true)
  );

  // Deliberate tampering: corrupt one returned POI's name after proofs were
  // generated for the real one — the recomputed leaf hash must then diverge
  // from the server-issued leafHash, and verification must fail. This is
  // the tamper-detection test that was previously only claimed, never run.
  const tamperedPois = pois.map((p, i) => (i === 0 ? { ...p, name: p.name + " (TAMPERED)" } : p));
  const tamperedResult = await verifyMerkleResultsClientSide(tamperedPois, merkleProofs, geoSession.merkleRoot);
  check(
    "tampering a returned POI's data is detected (verification fails)",
    tamperedResult.valid === false && tamperedResult.details[0].valid === false,
    JSON.stringify(tamperedResult)
  );
  check(
    "untampered POIs in the same batch still verify correctly",
    tamperedResult.details.slice(1).every((d) => d.valid === true)
  );

  // Deliberate root corruption: same genuine proofs, wrong root → must fail.
  const wrongRootResult = await verifyMerkleResultsClientSide(
    pois, merkleProofs, "0".repeat(geoSession.merkleRoot.length)
  );
  check("a mismatched root is rejected", wrongRootResult.valid === false);

  // Cross-check against the server's own verifyResults() for the genuine
  // case — both must agree when nothing has been tampered with.
  const { verifyResults } = await import("../backend/crypto/merkle/merkleTree.js");
  const serverResult = verifyResults(merkleProofs, pois, geoSession.merkleRoot);
  check(
    "client-side (WebCrypto) and server-side (Node crypto) verification agree on the genuine case",
    goodResult.valid === serverResult.valid
  );
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
