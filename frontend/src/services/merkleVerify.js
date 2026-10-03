/**
 * VEIL — Client-Side Merkle Proof Verification
 *
 * WHY THIS FILE EXISTS:
 * Before this, the app displayed `resolveData.verificationResult` — a value
 * computed and self-reported by the SERVER — under a "Merkle Verification"
 * badge, while the Protocol panel's copy said "Client verifies each
 * returned POI against the committed Merkle root." That wasn't true: no
 * independent verification was happening in the browser at all, just a
 * server assertion of its own correctness, which proves nothing about
 * tampering by that same server.
 *
 * This module makes that claim true: it recomputes each POI's leaf hash
 * and replays its Merkle proof path using the browser's own SubtleCrypto
 * SHA-256, byte-for-byte matching backend/crypto/merkle/merkleTree.js
 * (poiLeafHash, combineHashes, verifyProof) — which is NOT modified.
 * Only additive, read-only client logic; no API contract changes.
 */

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Mirrors backend poiLeafHash() exactly:
 *   id (utf8) || 0x00 || lat (float64 BE) || lng (float64 BE) || 0x00
 *   || name (utf8) || 0x00 || category (utf8)
 */
async function poiLeafHash(poi) {
  const idB = utf8Bytes(poi.id);
  const nameB = utf8Bytes(poi.name);
  const catB = utf8Bytes(poi.category);
  const coordBuf = new ArrayBuffer(16);
  const dv = new DataView(coordBuf);
  dv.setFloat64(0, poi.latitude, false);
  dv.setFloat64(8, poi.longitude, false);

  const buf = concatBytes(
    idB, new Uint8Array([0]), new Uint8Array(coordBuf),
    new Uint8Array([0]), nameB, new Uint8Array([0]), catB
  );
  return sha256Hex(buf);
}

/** Mirrors backend combineHashes(): sha256(hexBytes(left) || hexBytes(right)) */
async function combineHashes(leftHex, rightHex) {
  return sha256Hex(concatBytes(hexToBytes(leftHex), hexToBytes(rightHex)));
}

/** Mirrors backend verifyProof(): replay the sibling path, compare to root. */
async function verifyProofPath(leafHashHex, proof, expectedRootHex) {
  let current = leafHashHex;
  for (const step of proof) {
    current = step.position === "left"
      ? await combineHashes(step.hash, current)
      : await combineHashes(current, step.hash);
  }
  return current === expectedRootHex;
}

/**
 * Independently verify every returned POI against the published Merkle root,
 * entirely in the browser.
 *
 * @param {object[]} pois          - POI objects from /api/gc/resolve (resolveData.pois)
 * @param {object[]} merkleProofs  - [{poiId, leafHash, proof}] from /api/gc/resolve
 * @param {string}   root          - full-length merkle root hex (gcBundle.merkleRoot)
 * @returns {Promise<{valid: boolean, details: object[], computedClientSide: true}>}
 */
export async function verifyMerkleResultsClientSide(pois, merkleProofs, root) {
  if (!root || !merkleProofs?.length) {
    return { valid: false, details: [], computedClientSide: true, reason: "No proofs to verify" };
  }
  const poiMap = new Map(pois.map((p) => [p.id, p]));

  const details = await Promise.all(merkleProofs.map(async ({ poiId, leafHash, proof }) => {
    const poi = poiMap.get(poiId);
    if (!poi) return { poiId, valid: false, reason: "POI not found in result set" };

    const recomputedLeaf = await poiLeafHash(poi);
    if (recomputedLeaf !== leafHash) {
      return { poiId, valid: false, reason: "Leaf hash mismatch — POI data does not match server's committed leaf" };
    }

    const pathValid = await verifyProofPath(leafHash, proof, root);
    return {
      poiId,
      valid: pathValid,
      reason: pathValid ? "Verified independently in-browser" : "Merkle path does not reconstruct the published root",
    };
  }));

  return {
    valid: details.every((d) => d.valid),
    details,
    computedClientSide: true,
  };
}
