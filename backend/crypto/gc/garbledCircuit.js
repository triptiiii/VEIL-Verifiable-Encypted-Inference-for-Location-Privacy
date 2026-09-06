/**
 * VEIL — Garbled Circuit Module (SERVER SIDE)
 *
 * Phase 1 fixes:
 *
 * FIX 1 — Hash consistency:
 *   garbleAND allocates idC first and uses idC as the hash index.
 *   evaluateCircuit uses gate.outputWire. Now they match.
 *
 * FIX 2 — Virtual/constant wires:
 *   ONE_WIRE and ZERO_WIRE labels are included in serverInputLabels
 *   so the client evaluator can seed wireValues for them. NOT gates
 *   are implemented as XOR(b, ONE_WIRE) — Free-XOR, zero AND cost.
 *
 * FIX 3 — Squarer correctness:
 *   The old squarer pushed the same wire ID twice and XOR-reduced:
 *   XOR(x, x) = 0 — wrong. A squarer needs proper carry-propagating
 *   addition. New implementation uses schoolbook rows with ripple-carry
 *   accumulation (fullAdderCell / halfAdderCell for carry propagation).
 *
 * FIX 4 — Absolute value before squaring:
 *   (x_c - x_p) in two's complement is a large positive number when
 *   x_c < x_p. Squaring that gives a wrong value. We now compute
 *   |dx| via: sign = NOT(carry_out); abs = (bits XOR sign) + sign.
 *   All XOR steps are Free-XOR (zero AES calls); only the half-adder
 *   increment costs 1 AND gate per bit.
 */

import crypto from "crypto";

const LABEL_BYTES = 16;

function randomLabel() { return crypto.randomBytes(LABEL_BYTES); }

function xorBufs(a, b) {
  const out = Buffer.alloc(LABEL_BYTES);
  for (let i = 0; i < LABEL_BYTES; i++) out[i] = a[i] ^ b[i];
  return out;
}

function pointerBit(label) { return label[LABEL_BYTES - 1] & 1; }

function setPointerBit(label, bit) {
  const out = Buffer.from(label);
  out[LABEL_BYTES - 1] = (out[LABEL_BYTES - 1] & 0xfe) | (bit & 1);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXED KEY — "VEIL_GC_KEY_FIXE" (16 bytes, ASCII)
// bytes: 56 45 49 4C 5F 47 43 5F 4B 45 59 5F 46 49 58 45
// Client replicates with AES-CBC(iv=0): first 16 bytes == AES-ECB.
// ─────────────────────────────────────────────────────────────────────────────
export const FIXED_KEY = Buffer.from("VEIL_GC_KEY_FIXED", "utf8").subarray(0, 16);

function garbleHash(labelA, labelB, wireId) {
  const gidBuf = Buffer.alloc(LABEL_BYTES, 0);
  gidBuf.writeUInt32BE(wireId >>> 0, 12);
  const tweak = xorBufs(xorBufs(labelA, labelB), gidBuf);
  const cipher = crypto.createCipheriv("aes-128-ecb", FIXED_KEY, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(tweak), cipher.final()]);
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRE STORE
// ─────────────────────────────────────────────────────────────────────────────

class WireStore {
  constructor(delta) {
    this.delta = delta;
    this.wires = new Map();
    this._nextId = 0;
  }
  newWire() {
    const id = this._nextId++;
    let w0 = randomLabel();
    w0 = setPointerBit(w0, 0);
    const w1 = xorBufs(w0, this.delta);
    this.wires.set(id, { w0, w1 });
    return id;
  }
  label(wireId, bit) {
    const { w0, w1 } = this.wires.get(wireId);
    return bit === 0 ? w0 : w1;
  }
  labelPair(wireId) { return this.wires.get(wireId); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function garbleXOR(store, wireA, wireB) {
  const idC = store._nextId++;
  const w0c = xorBufs(store.label(wireA, 0), store.label(wireB, 0));
  const w1c = xorBufs(w0c, store.delta);
  store.wires.set(idC, { w0: w0c, w1: w1c });
  return { type: "XOR", inputWires: [wireA, wireB], outputWire: idC };
}

// FIX 1: idC allocated before hash calls so garble and eval use same index.
function garbleAND(store, wireA, wireB) {
  const w0a = store.label(wireA, 0), w1a = store.label(wireA, 1);
  const w0b = store.label(wireB, 0), w1b = store.label(wireB, 1);
  const p_a = pointerBit(w0a), p_b = pointerBit(w0b);

  const idC = store._nextId++; // ← FIRST

  const Hg0 = garbleHash(w0a, Buffer.alloc(16), idC * 2);
  const Hg1 = garbleHash(w1a, Buffer.alloc(16), idC * 2);
  let Tg = xorBufs(Hg0, Hg1);
  if (p_b) Tg = xorBufs(Tg, store.delta);

  const He0 = garbleHash(w0b, Buffer.alloc(16), idC * 2 + 1);
  const He1 = garbleHash(w1b, Buffer.alloc(16), idC * 2 + 1);
  let Te = xorBufs(xorBufs(He0, He1), w0a);

  let w0c = xorBufs(Hg0, He0);
  if (p_a) w0c = xorBufs(w0c, Tg);
  if (p_b) w0c = xorBufs(w0c, xorBufs(Te, w0a));

  const w1c = xorBufs(w0c, store.delta);
  store.wires.set(idC, { w0: w0c, w1: w1c });

  return { type: "AND", inputWires: [wireA, wireB], outputWire: idC, tg: Tg, te: Te };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARITHMETIC BUILDING BLOCKS
// ─────────────────────────────────────────────────────────────────────────────

/** Half adder: (sum, carry) = a + b.  Cost: 1 AND + 1 XOR. */
function halfAdderCell(store, gates, wireA, wireB) {
  const xg = garbleXOR(store, wireA, wireB); gates.push(xg);
  const ag = garbleAND(store, wireA, wireB); gates.push(ag);
  return { sumWire: xg.outputWire, carryWire: ag.outputWire };
}

/** Full adder: (sum, carry) = a + b + cin.  Cost: 2 AND + 3 XOR. */
function fullAdderCell(store, gates, wireA, wireB, wireCin) {
  const xAB  = garbleXOR(store, wireA, wireB);             gates.push(xAB);
  const aAB  = garbleAND(store, wireA, wireB);             gates.push(aAB);
  const aXC  = garbleAND(store, xAB.outputWire, wireCin); gates.push(aXC);
  const sumG = garbleXOR(store, xAB.outputWire, wireCin); gates.push(sumG);
  const carG = garbleXOR(store, aAB.outputWire, aXC.outputWire); gates.push(carG);
  return { sumWire: sumG.outputWire, carryWire: carG.outputWire };
}

/**
 * n-bit subtractor: result = a − b (two's complement)
 *
 * NOT(b[i]) = b[i] XOR ONE_WIRE  (Free-XOR — zero AND cost)
 * ONE_WIRE is a constant-1 wire; server injects W¹ in serverInputLabels.
 *
 * Returns { outputWires: [bit_0..bit_{n-1}, carry_out], oneWireId }
 * carry_out = 1  ↔  a ≥ b  (no borrow)
 * carry_out = 0  ↔  a < b  (borrow occurred)
 */
function buildSubtractor(store, gates, aWires, bWires) {
  const n = aWires.length;
  const ONE_WIRE = store.newWire(); // server injects W¹

  // NOT(b) via XOR with constant-1 (Free-XOR)
  const bInv = bWires.map(bw => {
    const g = garbleXOR(store, bw, ONE_WIRE); gates.push(g);
    return g.outputWire;
  });

  let carry = ONE_WIRE; // carry-in = 1 for two's complement
  const resultWires = [];
  for (let i = 0; i < n; i++) {
    const { sumWire, carryWire } = fullAdderCell(store, gates, aWires[i], bInv[i], carry);
    resultWires.push(sumWire);
    carry = carryWire;
  }
  resultWires.push(carry); // carry_out at index n

  return { outputWires: resultWires, oneWireId: ONE_WIRE };
}

/**
 * Compute |dx| from a subtractor result (two's complement absolute value).
 *
 * sign = NOT(carry_out) = carry_out XOR ONE_WIRE  (Free-XOR)
 * If sign=0: dx ≥ 0, abs = dx
 * If sign=1: dx < 0, abs = NOT(dx) + 1  =  (dx XOR sign) + sign
 *
 * XOR steps are all Free-XOR (zero AND cost).
 * Increment uses half-adder chain (1 AND per bit).
 *
 * Returns n-bit unsigned absolute value wire array.
 */
function buildAbsoluteValue(store, gates, subtractorResult, oneWireId) {
  const n = subtractorResult.length - 1; // data bits (excludes carry_out)
  const carryOutWire = subtractorResult[n];

  // sign = NOT(carry_out)
  const signG = garbleXOR(store, carryOutWire, oneWireId); gates.push(signG);
  const signWire = signG.outputWire;

  // Conditional bit-flip (Free-XOR)
  const flipped = subtractorResult.slice(0, n).map(bw => {
    const g = garbleXOR(store, bw, signWire); gates.push(g);
    return g.outputWire;
  });

  // Increment: abs = flipped + sign  (half-adder chain, carry-in = sign)
  let carry = signWire;
  const absWires = [];
  for (let i = 0; i < n; i++) {
    const { sumWire, carryWire } = halfAdderCell(store, gates, flipped[i], carry);
    absWires.push(sumWire);
    carry = carryWire;
  }
  // carry is discarded (result bounded in n bits for Bengaluru coords)
  return absWires;
}

/**
 * Schoolbook squarer: result = a²  (a is unsigned n-bit)
 *
 * Algorithm:
 *   For each bit i, compute partial products pp[j] = a[i] AND a[j],
 *   then add the n-bit row into the accumulator at offset i using
 *   a ripple-carry adder. Carry is propagated through remaining positions.
 *
 * This is correct binary multiplication (replaces the broken XOR-reduction
 * version that pushed the same wire twice and XOR'd to get 0).
 *
 * ZERO_WIRE is a constant-0 wire (server injects W⁰).
 *
 * Returns { outputWires (2n bits), zeroWireId }
 */
function buildSquarer(store, gates, aWires) {
  const n = aWires.length;
  const resultLen = 2 * n;
  const ZERO_WIRE = store.newWire(); // server injects W⁰

  // Accumulator: starts all-zero
  let acc = Array.from({ length: resultLen }, () => ZERO_WIRE);

  for (let i = 0; i < n; i++) {
    // Partial product row i: pp[j] = a[i] AND a[j]
    const pp = aWires.map(aWireJ => {
      const g = garbleAND(store, aWires[i], aWireJ); gates.push(g);
      return g.outputWire;
    });

    // Ripple-carry add pp into acc at bit offset i
    let carry = ZERO_WIRE;
    for (let j = 0; j < n; j++) {
      const pos = i + j;
      if (pos >= resultLen) break;
      const { sumWire, carryWire } = fullAdderCell(store, gates, acc[pos], pp[j], carry);
      acc[pos] = sumWire;
      carry = carryWire;
    }
    // Propagate carry through remaining positions (half-adder: add 0 + carry)
    for (let pos = i + n; pos < resultLen; pos++) {
      const { sumWire, carryWire } = halfAdderCell(store, gates, acc[pos], carry);
      acc[pos] = sumWire;
      carry = carryWire;
    }
  }

  return { outputWires: acc, zeroWireId: ZERO_WIRE };
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-POI DISTANCE CIRCUIT
// Computes dist² = |x_c − x_p|² + |y_c − y_p|²
// All constant/virtual wire labels are added to serverInputLabels.
// ─────────────────────────────────────────────────────────────────────────────

function intToBits(n, width) {
  const bits = [];
  const absN = Math.abs(Math.round(n));
  for (let i = 0; i < width; i++) bits.push((absN >> i) & 1);
  return bits;
}

function garblePOIDistanceCircuit(store, gates, xClientWires, yClientWires, xPOIBits, yPOIBits) {
  const COORD_BITS = xClientWires.length; // 32

  // Server-side POI coordinate wires
  const xPoiWires = xPOIBits.map(() => store.newWire());
  const yPoiWires = yPOIBits.map(() => store.newWire());

  const serverInputLabels = {};

  // POI coordinate active labels (server knows which bit each wire carries)
  xPoiWires.forEach((wid, i) => {
    serverInputLabels[wid] = store.label(wid, xPOIBits[i]).toString("hex");
  });
  yPoiWires.forEach((wid, i) => {
    serverInputLabels[wid] = store.label(wid, yPOIBits[i]).toString("hex");
  });

  // Subtractors: dx = x_c − x_p,  dy = y_c − y_p
  const dxSub = buildSubtractor(store, gates, xClientWires, xPoiWires);
  const dySub = buildSubtractor(store, gates, yClientWires, yPoiWires);

  // ONE_WIRE labels (carry-in = 1)
  serverInputLabels[dxSub.oneWireId] = store.label(dxSub.oneWireId, 1).toString("hex");
  serverInputLabels[dySub.oneWireId] = store.label(dySub.oneWireId, 1).toString("hex");

  // Absolute values: |dx|, |dy|  (each COORD_BITS wide)
  const absDx = buildAbsoluteValue(store, gates, dxSub.outputWires, dxSub.oneWireId);
  const absDy = buildAbsoluteValue(store, gates, dySub.outputWires, dySub.oneWireId);

  // Squarers: dx², dy²  (each 2*COORD_BITS wide)
  const dx2 = buildSquarer(store, gates, absDx);
  const dy2 = buildSquarer(store, gates, absDy);

  // ZERO_WIRE labels (constant 0)
  serverInputLabels[dx2.zeroWireId] = store.label(dx2.zeroWireId, 0).toString("hex");
  serverInputLabels[dy2.zeroWireId] = store.label(dy2.zeroWireId, 0).toString("hex");

  // Final adder: dist² = dx² + dy²
  const sumLen = Math.max(dx2.outputWires.length, dy2.outputWires.length) + 1;
  const ADD_ZERO = store.newWire(); // carry-in = 0, padding = 0
  serverInputLabels[ADD_ZERO] = store.label(ADD_ZERO, 0).toString("hex");

  const distWires = [];
  let carry = ADD_ZERO;
  for (let i = 0; i < sumLen - 1; i++) {
    const aw = i < dx2.outputWires.length ? dx2.outputWires[i] : ADD_ZERO;
    const bw = i < dy2.outputWires.length ? dy2.outputWires[i] : ADD_ZERO;
    const { sumWire, carryWire } = fullAdderCell(store, gates, aw, bw, carry);
    distWires.push(sumWire);
    carry = carryWire;
  }
  distWires.push(carry);

  return { distWires, serverInputLabels };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export function garbleCircuit(pois, k = 5) {
  const COORD_BITS = 32;

  let delta = crypto.randomBytes(LABEL_BYTES);
  delta[LABEL_BYTES - 1] |= 1;

  const store = new WireStore(delta);
  const gates = [];

  const xClientWires = Array.from({ length: COORD_BITS }, () => store.newWire());
  const yClientWires = Array.from({ length: COORD_BITS }, () => store.newWire());

  const poiCircuits = [];

  for (const poi of pois) {
    const xPOIBits = intToBits(Math.round(poi.latitude  * 1e6), COORD_BITS);
    const yPOIBits = intToBits(Math.round(poi.longitude * 1e6), COORD_BITS);
    const { distWires, serverInputLabels } = garblePOIDistanceCircuit(
      store, gates, xClientWires, yClientWires, xPOIBits, yPOIBits
    );
    poiCircuits.push({ poiId: poi.id, distWires, serverInputLabels });
  }

  const serializedGates = gates.map(g => ({
    type: g.type,
    inputWires: g.inputWires,
    outputWire: g.outputWire,
    tg: g.tg?.toString("hex") ?? null,
    te: g.te?.toString("hex") ?? null,
  }));

  const clientInputWireLabels = {};
  [...xClientWires, ...yClientWires].forEach(wid => {
    const { w0, w1 } = store.labelPair(wid);
    clientInputWireLabels[wid] = { w0: w0.toString("hex"), w1: w1.toString("hex") };
  });

  const _wireStoreSerialized = Object.fromEntries(
    [...store.wires.entries()].map(([wid, { w0, w1 }]) => [
      wid, { w0: w0.toString("hex"), w1: w1.toString("hex") }
    ])
  );

  return {
    delta: delta.toString("hex"),
    numGates: gates.length,
    garbledGates: serializedGates,
    xClientWires,
    yClientWires,
    clientInputWireLabels,
    poiCircuits,
    _wireStoreSerialized, // server-side only
  };
}

/**
 * Build the bundle sent to the client.
 * Excludes _wireStoreSerialized.
 * Includes serverActiveLabels for ALL server-injected wires
 * (POI coords, ONE_WIREs, ZERO_WIREs).
 */
export function buildClientBundle(gc) {
  const clientWireList = [...gc.xClientWires, ...gc.yClientWires];
  const clientWirePairs = clientWireList.map(wid => gc.clientInputWireLabels[wid]);

  const serverActiveLabels = {};
  for (const pc of gc.poiCircuits) {
    Object.assign(serverActiveLabels, pc.serverInputLabels);
  }

  const outputDecryptors = {};
  for (const pc of gc.poiCircuits) {
    for (const wid of pc.distWires) {
      const entry = gc._wireStoreSerialized[wid];
      if (entry) outputDecryptors[wid] = entry.w0;
    }
  }

  const poiCircuitMeta = gc.poiCircuits.map(pc => ({
    poiId: pc.poiId,
    distWires: pc.distWires,
  }));

  return {
    garbledGates: gc.garbledGates,
    clientWireList,
    clientWirePairs,
    serverActiveLabels,
    outputDecryptors,
    poiCircuitMeta,
    delta: gc.delta,
    numGates: gc.numGates,
    numPOIs: gc.poiCircuits.length,
  };
}
