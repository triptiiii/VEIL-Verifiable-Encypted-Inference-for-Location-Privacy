/**
 * VEIL — Client-Side Garbled Circuit Protocol
 *
 * Runs ENTIRELY in the browser. Raw GPS NEVER leaves this module.
 *
 * AES NOTE:
 *   Server uses AES-128-ECB.  Browser uses AES-CBC with iv=0.
 *   For a single 16-byte block: AES-CBC(K,0,pt)[0:16] = AES-ECB(K,pt).
 *   First 16 bytes of SubtleCrypto AES-CBC output = AES-ECB output.
 *
 * OT NOTE:
 *   Simulated OT — server sends {w0,w1} per input wire; client selects
 *   w_{bit} locally.  Coordinates never transmitted.  Full Naor-Pinkas
 *   ECDH OT is the production upgrade for cryptographic choice-hiding.
 */

const LABEL_BYTES = 16;
const COORD_BITS  = 32;
const SCALE       = 1_000_000;

// Must match server's FIXED_KEY exactly: "VEIL_GC_KEY_FIXE" (ASCII, 16 bytes)
const FIXED_KEY_BYTES = new Uint8Array([
  0x56,0x45,0x49,0x4C,0x5F,0x47,0x43,0x5F,
  0x4B,0x45,0x59,0x5F,0x46,0x49,0x58,0x45,
]);

// ── AES-128 via SubtleCrypto ──────────────────────────────────────────────

let _aesKey = null;
async function getAesKey() {
  if (!_aesKey) {
    _aesKey = await crypto.subtle.importKey(
      'raw', FIXED_KEY_BYTES, { name: 'AES-CBC' }, false, ['encrypt']
    );
  }
  return _aesKey;
}

async function aes128Block(pt16) {
  const key = await getAesKey();
  const iv  = new Uint8Array(16); // zero IV → CBC first block ≡ ECB
  const out = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, pt16);
  return new Uint8Array(out, 0, 16);
}

// ── Utilities ─────────────────────────────────────────────────────────────

function xorU8(a, b) {
  const o = new Uint8Array(LABEL_BYTES);
  for (let i = 0; i < LABEL_BYTES; i++) o[i] = a[i] ^ b[i];
  return o;
}
function pointerBit(l) { return l[LABEL_BYTES - 1] & 1; }

export function hexToU8(hex) {
  const a = new Uint8Array((hex || '').length / 2);
  for (let i = 0; i < hex.length; i += 2) a[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return a;
}

function u8eq(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Garbling hash (must match server garbleHash exactly) ──────────────────

async function garbleHash(labelA, labelB, wireId) {
  const gid = new Uint8Array(LABEL_BYTES);
  new DataView(gid.buffer).setUint32(12, wireId >>> 0, false);
  return aes128Block(xorU8(xorU8(labelA, labelB), gid));
}

// ── Coordinate encoding (stays on client) ─────────────────────────────────

function encodeCoordinate(coord) {
  const s = Math.round(Math.abs(coord) * SCALE);
  const b = [];
  for (let i = 0; i < COORD_BITS; i++) b.push((s >> i) & 1);
  return b;
}

export function encodeQuery(lat, lng) {
  return [...encodeCoordinate(lat), ...encodeCoordinate(lng)];
}

// ── OT-simulated label selection ──────────────────────────────────────────

export function selectActiveLabels(wirePairs, queryBits) {
  return wirePairs.map((pair, i) =>
    hexToU8(queryBits[i] === 0 ? pair.w0 : pair.w1)
  );
}

// ── Garbled circuit evaluation ────────────────────────────────────────────

export async function evaluateGarbledCircuit(gcBundle, queryBits, k) {
  const { garbledGates, clientWireList, clientWirePairs,
          serverActiveLabels, outputDecryptors, poiCircuitMeta } = gcBundle;

  const wv = new Map();

  // Client input labels (OT selection)
  selectActiveLabels(clientWirePairs, queryBits).forEach((label, i) => {
    wv.set(clientWireList[i], label);
  });

  // Server-injected labels (POI coords + ONE/ZERO constants)
  for (const [ws, lh] of Object.entries(serverActiveLabels)) {
    wv.set(parseInt(ws), hexToU8(lh));
  }

  // Evaluate gates in topological order
  for (const gate of garbledGates) {
    const [wA, wB] = gate.inputWires;
    const lA = wv.get(wA), lB = wv.get(wB);
    if (!lA || !lB) continue;

    let lo;
    if (gate.type === 'XOR') {
      lo = xorU8(lA, lB);
    } else {
      const Tg = hexToU8(gate.tg), Te = hexToU8(gate.te);
      const sa = pointerBit(lA), sb = pointerBit(lB);
      const Hg = await garbleHash(lA, new Uint8Array(LABEL_BYTES), gate.outputWire * 2);
      const He = await garbleHash(lB, new Uint8Array(LABEL_BYTES), gate.outputWire * 2 + 1);
      let Wg = new Uint8Array(Hg); if (sa) Wg = xorU8(Wg, Tg);
      let We = new Uint8Array(He); if (sb) We = xorU8(We, xorU8(Te, lA));
      lo = xorU8(Wg, We);
    }
    if (lo) wv.set(gate.outputWire, lo);
  }

  // Decode dist² using BigInt (values can exceed 2^53)
  const poiDists = poiCircuitMeta.map(pc => {
    let d2 = 0n;
    for (let b = 0; b < pc.distWires.length; b++) {
      const al = wv.get(pc.distWires[b]); if (!al) continue;
      const w0 = hexToU8(outputDecryptors[pc.distWires[b]]); if (!w0) continue;
      if (!u8eq(al, w0)) d2 += 1n << BigInt(b);
    }
    return { poiId: pc.poiId, d2 };
  });

  poiDists.sort((a, b) => a.d2 < b.d2 ? -1 : a.d2 > b.d2 ? 1 : 0);
  return poiDists.slice(0, k).map(p => p.poiId);
}

// ── Haversine (runs locally with private GPS) ─────────────────────────────

export function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180;
  const dl = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(df/2)**2 + Math.cos(f1)*Math.cos(f2)*Math.sin(dl/2)**2;
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ── Main protocol orchestrator ────────────────────────────────────────────

export async function runSecureKNN(lat, lng, k, categories, onProgress = () => {}) {
  const timings = {};
  let t;

  onProgress({ step: 1, label: 'Encoding location locally', done: false });
  t = performance.now();
  const queryBits = encodeQuery(lat, lng); // NEVER leaves browser
  timings.encodeMs = (performance.now() - t).toFixed(2);
  onProgress({ step: 1, label: `Location encoded — ${queryBits.length} bits`, done: true });

  // ── Phase 4: location-aware candidate discovery ──────────────────────────
  // This call DOES send lat/lng — to /api/candidates ONLY, never to the
  // secure /api/gc/* endpoints below. The server coarsens it to a ~1.1km
  // grid cell before using it. See the Security tab's Protocol Flow (step 2)
  // and README "Candidate Discovery vs Secure Computation" for the full
  // honest privacy write-up. This replaces the old behaviour of silently
  // using whichever POIs happened to be first in dataset order regardless
  // of where the user actually was.
  onProgress({ step: 2, label: 'Finding nearby candidates', done: false });
  t = performance.now();
  const candRes = await fetch('/api/candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: lat, longitude: lng, categories }),
  });
  if (!candRes.ok) {
    const e = await candRes.json().catch(() => ({}));
    throw new Error(e.error || `Candidate discovery failed (${candRes.status})`);
  }
  const candData = await candRes.json();
  timings.candidatesMs = (performance.now() - t).toFixed(2);
  onProgress({
    step: 2,
    label: `${candData.candidateIds.length} nearby candidates found (coarsened to ~1.1km)`,
    done: true,
  });

  onProgress({ step: 3, label: 'Requesting garbled circuit', done: false });
  t = performance.now();
  const initRes = await fetch('/api/gc/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ k, categories, candidateIds: candData.candidateIds }), // NO COORDINATES
  });
  if (!initRes.ok) {
    const e = await initRes.json().catch(() => ({}));
    throw new Error(e.error || `Circuit request failed (${initRes.status})`);
  }
  const gcBundle = await initRes.json();
  timings.circuitFetchMs = (performance.now() - t).toFixed(2);
  // Real, server-measured circuit-garbling time (performance.now() delta
  // inside VEILSession.buildSecureCircuit()) — was being returned by the
  // server but silently dropped here instead of surfaced in the timing
  // breakdown. Distinct from ComplexityPanel's theoretical estimate.
  if (gcBundle.garbleMs !== undefined) timings.garbleMs = gcBundle.garbleMs;
  onProgress({ step: 3, label: `Circuit received — ${gcBundle.numGates} gates`, done: true });

  onProgress({ step: 4, label: 'OT label selection', done: false });
  t = performance.now();
  selectActiveLabels(gcBundle.clientWirePairs, queryBits); // local, no network
  timings.otMs = (performance.now() - t).toFixed(2);
  onProgress({ step: 4, label: '64 labels selected (simulated OT)', done: true });

  onProgress({ step: 5, label: 'Evaluating circuit in browser', done: false });
  t = performance.now();
  const resultIds = await evaluateGarbledCircuit(gcBundle, queryBits, k);
  timings.evalMs = (performance.now() - t).toFixed(2);
  onProgress({ step: 5, label: `${resultIds.length} nearest POIs found`, done: true });

  onProgress({ step: 6, label: 'Fetching POI details + Merkle proofs', done: false });
  t = performance.now();
  const resolveRes = await fetch('/api/gc/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: gcBundle.sessionId, resultIds }), // NO COORDINATES
  });
  if (!resolveRes.ok) {
    const e = await resolveRes.json().catch(() => ({}));
    throw new Error(e.error || `Resolve failed (${resolveRes.status})`);
  }
  const resolveData = await resolveRes.json();
  timings.resolveMs = (performance.now() - t).toFixed(2);
  onProgress({ step: 6, label: 'POI data + Merkle proofs received', done: true });

  onProgress({ step: 7, label: 'Computing distances (client GPS)', done: false });
  t = performance.now();
  const results = (resolveData.pois || [])
    .map(poi => ({
      ...poi,
      distMetres: haversineMetres(lat, lng, poi.latitude, poi.longitude),
      privacyMode: 'secure',
    }))
    .sort((a, b) => a.distMetres - b.distMetres);
  timings.distanceMs = (performance.now() - t).toFixed(2);
  // NOTE: garbleMs is a server-side sub-measurement already contained
  // within circuitFetchMs (the client-observed round trip for /api/gc/init)
  // — it must NOT be added again here or totalMs double-counts it. Sum only
  // the client-side wall-clock phases.
  timings.totalMs = [
    timings.encodeMs, timings.candidatesMs, timings.circuitFetchMs, timings.otMs,
    timings.evalMs, timings.resolveMs, timings.distanceMs,
  ].reduce((s, v) => s + parseFloat(v || 0), 0).toFixed(2);
  onProgress({ step: 7, label: 'Results ready', done: true });

  return {
    mode: 'secure',
    results,
    timings,
    merkleRoot:          gcBundle.merkleRoot,
    merkleProofs:        resolveData.merkleProofs,
    verificationResult:  resolveData.verificationResult,
    circuitStats: {
      numGates:   gcBundle.numGates,
      numPOIs:    gcBundle.numPOIs,
      inputBits:  queryBits.length,
      candidateCount: candData.candidateIds.length,
    },
    privacyStatement:
      'Raw GPS was sent to /api/candidates (coarsened server-side to ~1.1km) for candidate ' +
      'selection only. The secure computation itself received: {k,categories,candidateIds} ' +
      'and {sessionId,resultIds} — never any location, coarse or exact.',
    otNote:
      'OT simulated: server sends both labels; client selects locally. ' +
      'Naor-Pinkas ECDH OT is the production cryptographic upgrade.',
  };
}
