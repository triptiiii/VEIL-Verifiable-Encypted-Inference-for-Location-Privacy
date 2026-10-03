/**
 * VEIL — Plain vs Secure kNN Benchmark (Phase 5)
 *
 * Runs the FULL pipeline in one process — candidate discovery, plain kNN,
 * garbling, an independent client-side circuit evaluation (Node's
 * `crypto.webcrypto`, the same W3C SubtleCrypto interface a real browser
 * exposes — see test/run_tests.mjs's header comment for the same caveat:
 * this is a strong check, but it is not a literal browser), resolve, and
 * Merkle verification — measuring each phase with real `performance.now()`
 * timestamps. Nothing here is hardcoded or estimated.
 *
 * Two ways to run it:
 *   node test/benchmark.mjs
 *     → tries to fetch the real, live OpenStreetMap dataset first (requires
 *       internet access to overpass-api.de). Falls back to a small labelled
 *       SYNTHETIC fixture if that fails, and says so loudly — it never
 *       silently substitutes fake data for real data.
 *
 *   node test/benchmark.mjs --lat 12.92 --lng 77.52 --k 5 --categories hospital
 *     → same, with a specific query point / k / category filter.
 *
 * Exports runBenchmark() so the automated test suite (run_tests.mjs) can
 * assert on its output (numeric timings, plain/secure agreement, etc.)
 * without shelling out to a second process.
 */

import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { VEILSession } from "../backend/crypto/veil.js";
import { plainKNN } from "../backend/geometry/knn.js";
import { verifyResults } from "../backend/crypto/merkle/merkleTree.js";
import { fetchPOIs, BENGALURU_BBOX } from "../backend/osm/fetcher.js";
import {
  encodeQuery,
  evaluateGarbledCircuit,
} from "../frontend/src/services/gcProtocol.js";

// ── Small labelled synthetic fallback (NOT real OSM data) ──────────────────
// Only used if a live Overpass fetch isn't possible in the current
// environment. Centred near the default query point below.
const SYNTHETIC_FALLBACK = [
  { id: "BENCH_h1", osmId: 901, name: "Benchmark Hospital #1", category: "hospital", latitude: 12.9210, longitude: 77.5210, tags: {} },
  { id: "BENCH_h2", osmId: 902, name: "Benchmark Hospital #2", category: "hospital", latitude: 12.9250, longitude: 77.5300, tags: {} },
  { id: "BENCH_h3", osmId: 903, name: "Benchmark Hospital #3", category: "hospital", latitude: 12.9600, longitude: 77.5900, tags: {} },
  { id: "BENCH_c1", osmId: 904, name: "Benchmark Cafe #1", category: "cafe", latitude: 12.9205, longitude: 77.5205, tags: {} },
  { id: "BENCH_c2", osmId: 905, name: "Benchmark Cafe #2", category: "cafe", latitude: 12.9700, longitude: 77.6100, tags: {} },
  { id: "BENCH_r1", osmId: 906, name: "Benchmark Restaurant #1", category: "restaurant", latitude: 12.9230, longitude: 77.5240, tags: {} },
  { id: "BENCH_p1", osmId: 907, name: "Benchmark Pharmacy #1", category: "pharmacy", latitude: 12.9220, longitude: 77.5220, tags: {} },
];

/**
 * Runs the full plain-vs-secure benchmark once against an already-built
 * VEILSession and returns a structured, JSON-serialisable result.
 */
export async function runBenchmark(session, { lat, lng, k = 5, categories = null, candidateLimit } = {}) {
  const filteredDatasetSize = (categories
    ? session.pois.filter((p) => categories.includes(p.category))
    : session.pois
  ).length;

  // ── Candidate discovery ───────────────────────────────────────────────
  let t = performance.now();
  const candidateResult = session.getLocationAwareCandidates(lat, lng, categories, candidateLimit);
  const candidateDiscoveryMs = +(performance.now() - t).toFixed(2);

  // ── Plain kNN — full filtered dataset (NOT the candidate-restricted set;
  //    see the workload-size note in the returned object) ────────────────
  t = performance.now();
  const plainResult = plainKNN({ latitude: lat, longitude: lng }, session.pois, k, categories);
  const plainQueryMs = +(performance.now() - t).toFixed(2);
  const plainIds = plainResult.map((p) => p.id);

  // ── Secure: garble over the SAME location-aware candidate set ──────────
  t = performance.now();
  const { bundle, dataset, garbleMs } =
    session.buildSecureCircuit(k, categories, candidateResult.candidateIds);
  const garbleRoundtripMs = +(performance.now() - t).toFixed(2);

  // ── Secure: client-side encode + evaluate (independent of the garbler —
  //    exactly the real protocol's trust boundary, just both roles running
  //    in this one process for reproducibility) ──────────────────────────
  t = performance.now();
  const queryBits = encodeQuery(lat, lng);
  const encodeMs = +(performance.now() - t).toFixed(2);

  t = performance.now();
  const secureIds = await evaluateGarbledCircuit(bundle, queryBits, k);
  const evalMs = +(performance.now() - t).toFixed(2);

  // ── Secure: resolve + Merkle verify ─────────────────────────────────────
  t = performance.now();
  const { pois: securePois, merkleProofs, verificationResult } =
    session.resolveSecureQuery(dataset, secureIds);
  const resolveMs = +(performance.now() - t).toFixed(2);

  t = performance.now();
  // resolveSecureQuery already ran verifyResults internally; re-run
  // explicitly here so its cost is measured on its own, matching what the
  // client does after /api/gc/resolve returns.
  const merkleCheck = verifyResults(merkleProofs, securePois, session.merkleRoot);
  const merkleVerifyMs = +(performance.now() - t).toFixed(2);

  const secureTotalMs = +(
    candidateDiscoveryMs + garbleRoundtripMs + encodeMs + evalMs + resolveMs + merkleVerifyMs
  ).toFixed(2);

  // Fair correctness comparison: same location, same k, same category
  // filter, same candidate set — do the two implementations agree on
  // which POIs are nearest? (Not comparing plain-over-full-dataset ids to
  // secure-over-candidate-set ids directly, since those can legitimately
  // differ if the true nearest POI wasn't in the discovered candidate set —
  // that's a candidate-discovery quality question, not a correctness bug.
  // The apples-to-apples check is plain-over-the-SAME-candidate-set vs
  // secure-over-that-set, exactly like test/run_tests.mjs section 9.)
  const plainOverCandidatesIds = plainKNN(
    { latitude: lat, longitude: lng }, dataset, k, categories
  ).map((p) => p.id);
  const secureAgreesWithPlainOverSameCandidates =
    JSON.stringify(plainOverCandidatesIds) === JSON.stringify(secureIds);

  return {
    query: { lat, lng, k, categories },
    workloadNote:
      `Plain kNN searched the full filtered dataset (${filteredDatasetSize} POIs). ` +
      `Secure VEIL kNN computed over the location-aware candidate set only ` +
      `(${dataset.length} POIs). Not equal-sized workloads by design — see README.`,
    timings: {
      candidateDiscoveryMs,
      plainQueryMs,
      secureCircuitGarbleMs: parseFloat(garbleMs),
      secureCircuitGarbleRoundtripMs: garbleRoundtripMs,
      secureClientEncodeMs: encodeMs,
      secureClientEvalMs: evalMs,
      secureResolveMs: resolveMs,
      merkleVerifyMs,
      secureTotalMs,
    },
    results: {
      plainIds,                       // plain kNN over the FULL filtered dataset
      plainOverCandidatesIds,         // plain kNN over the SAME candidate set as secure (fair comparison)
      secureIds,                      // secure kNN over the candidate set
      secureAgreesWithPlainOverSameCandidates,
      merkleAllVerified: merkleCheck.valid,
    },
    datasetSizes: {
      filteredDatasetSize,
      candidateSetSize: dataset.length,
      gateCount: bundle.numGates,
    },
  };
}

// ── CLI runner ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { lat: 12.9200, lng: 77.5200, k: 5, categories: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lat") out.lat = parseFloat(argv[++i]);
    else if (argv[i] === "--lng") out.lng = parseFloat(argv[++i]);
    else if (argv[i] === "--k") out.k = parseInt(argv[++i], 10);
    else if (argv[i] === "--categories") out.categories = argv[++i].split(",");
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let pois, source;
  try {
    console.log("Attempting live OpenStreetMap/Overpass fetch...");
    pois = await fetchPOIs(["hospital", "restaurant", "pharmacy", "cafe"], BENGALURU_BBOX, 500);
    if (!pois.length) throw new Error("Overpass returned zero POIs");
    source = `LIVE OpenStreetMap data (${pois.length} POIs)`;
  } catch (err) {
    console.warn(`Live fetch failed (${err.message}) — falling back to the labelled SYNTHETIC fixture.`);
    pois = SYNTHETIC_FALLBACK;
    source = `SYNTHETIC fallback fixture (${pois.length} POIs, NOT real OSM data)`;
  }

  const session = new VEILSession(pois);
  const result = await runBenchmark(session, args);

  console.log(`\nData source: ${source}`);
  console.log(`Query: lat=${args.lat}, lng=${args.lng}, k=${args.k}, categories=${args.categories || "all"}\n`);
  console.log("── Timings (ms, real, measured this run) ─────────────────────");
  for (const [k2, v] of Object.entries(result.timings)) console.log(`  ${k2.padEnd(32)} ${v}`);
  console.log("\n── Workload sizes ─────────────────────────────────────────────");
  console.log(`  ${result.workloadNote}`);
  console.log("\n── Correctness ─────────────────────────────────────────────────");
  console.log(`  Secure agrees with plain over the SAME candidate set: ${result.results.secureAgreesWithPlainOverSameCandidates}`);
  console.log(`  Merkle proofs all verified: ${result.results.merkleAllVerified}`);
  console.log(`  Plain (full dataset) top-k:      ${JSON.stringify(result.results.plainIds)}`);
  console.log(`  Plain (candidate set) top-k:     ${JSON.stringify(result.results.plainOverCandidatesIds)}`);
  console.log(`  Secure (candidate set) top-k:    ${JSON.stringify(result.results.secureIds)}`);
  console.log("");
}

import { fileURLToPath } from "node:url";
import path from "node:path";

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}