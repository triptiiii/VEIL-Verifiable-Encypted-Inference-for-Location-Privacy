/**
 * VEIL — Merkle Tree Module
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * After the secure kNN computation returns k POI results, we need a way
 * for the client to VERIFY that:
 *   1. The returned POIs are genuinely in the server's dataset
 *   2. The result set has not been tampered with or selectively omitted
 *   3. The server committed to its dataset BEFORE learning any query
 *
 * We use a Merkle tree over all POIs in the dataset:
 *   - Leaves: SHA-256(poi.id || poi.lat || poi.lng || poi.name || poi.category)
 *   - Internal nodes: SHA-256(left_child || right_child)
 *   - Root: published BEFORE query is received
 *
 * For each result POI, the server provides a Merkle PROOF:
 *   A path of sibling hashes from the leaf to the root.
 * The client verifies: hash_chain(leaf, siblings) == committed_root.
 *
 * This provides:
 *   - INCLUSION PROOF: The returned POI is definitely in the committed dataset
 *   - DATASET COMMITMENT: Server cannot add/remove POIs after root is published
 *   - LIGHTWEIGHT VERIFICATION: Client needs O(log n) hashes per proof
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMPLEXITY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Tree construction:     O(n log n) time, O(n) space
 * Proof generation:      O(log n) time and space
 * Proof verification:    O(log n) hash operations
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// HASHING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash of a buffer or string.
 * @param {Buffer|string} data
 * @returns {string} - hex-encoded 32-byte hash
 */
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Combine two child hashes to produce a parent hash.
 * Concatenates left || right (as hex strings) then hashes.
 * This is the standard Merkle combination function.
 *
 * @param {string} left  - hex hash
 * @param {string} right - hex hash
 * @returns {string}     - hex hash
 */
function combineHashes(left, right) {
  return sha256(Buffer.from(left + right, "hex"));
}

// ─────────────────────────────────────────────────────────────────────────────
// POI LEAF HASH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the leaf hash for a POI.
 *
 * Encodes the POI's canonical fields in a deterministic byte string:
 *   id (UTF-8) || "\x00" || lat (8-byte float64 BE) || lng (8-byte float64 BE)
 *   || "\x00" || name (UTF-8) || "\x00" || category (UTF-8)
 *
 * The \x00 separators prevent length-extension / collision attacks between
 * different field combinations.
 *
 * @param {object} poi - { id, latitude, longitude, name, category }
 * @returns {string}   - hex-encoded leaf hash
 */
export function poiLeafHash(poi) {
  const buf = Buffer.allocUnsafe(
    poi.id.length + 1 + 8 + 8 + 1 + poi.name.length + 1 + poi.category.length
  );
  let offset = 0;
  buf.write(poi.id, offset, "utf8");
  offset += poi.id.length;
  buf[offset++] = 0x00;
  buf.writeDoubleBE(poi.latitude, offset);
  offset += 8;
  buf.writeDoubleBE(poi.longitude, offset);
  offset += 8;
  buf[offset++] = 0x00;
  buf.write(poi.name, offset, "utf8");
  offset += poi.name.length;
  buf[offset++] = 0x00;
  buf.write(poi.category, offset, "utf8");

  return sha256(buf);
}

// ─────────────────────────────────────────────────────────────────────────────
// MERKLE TREE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MerkleTree class.
 *
 * Builds a complete binary Merkle tree over a set of leaves.
 * If the number of leaves is not a power of 2, the last leaf is
 * duplicated to fill the tree (standard Bitcoin-style approach).
 *
 * Internal representation:
 *   this.layers[0] = leaf hashes (level 0)
 *   this.layers[1] = parent hashes of pairs in layer 0
 *   ...
 *   this.layers[L] = [ root hash ]
 */
export class MerkleTree {
  /**
   * @param {string[]} leaves - Array of hex-encoded leaf hashes
   */
  constructor(leaves) {
    if (!leaves || leaves.length === 0) {
      throw new Error("MerkleTree requires at least one leaf");
    }

    this.layers = [];
    this._build(leaves);
  }

  _build(leaves) {
    // Pad to even length by duplicating the last leaf
    let current = [...leaves];
    if (current.length % 2 !== 0 && current.length > 1) {
      current.push(current[current.length - 1]);
    }

    this.layers.push(current);

    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] ?? current[i]; // duplicate if odd
        next.push(combineHashes(left, right));
      }
      this.layers.push(next);
      current = next;
    }
  }

  /**
   * The root hash of the tree.
   * @returns {string} - hex-encoded root hash (32 bytes)
   */
  get root() {
    return this.layers[this.layers.length - 1][0];
  }

  /**
   * Number of leaves in the tree.
   */
  get leafCount() {
    return this.layers[0].length;
  }

  /**
   * Generate a Merkle proof for leaf at position index.
   *
   * A Merkle proof is an ordered list of sibling hashes from the leaf
   * to the root.  Each entry includes:
   *   { hash: string, position: 'left' | 'right' }
   * where 'position' indicates whether the sibling is the LEFT or RIGHT child
   * at that level — needed by the verifier to reconstruct the correct order.
   *
   * Time: O(log n)
   * Space: O(log n)
   *
   * @param {number} index - 0-based leaf index
   * @returns {object[]}   - Array of { hash, position } proof steps
   */
  generateProof(index) {
    if (index < 0 || index >= this.layers[0].length) {
      throw new Error(`Invalid leaf index ${index}`);
    }

    const proof = [];
    let currentIndex = index;

    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const levelNodes = this.layers[layer];
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < levelNodes.length) {
        proof.push({
          hash: levelNodes[siblingIndex],
          position: isRight ? "left" : "right",
        });
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Get the leaf hash at a given index.
   * @param {number} index
   * @returns {string}
   */
  getLeaf(index) {
    return this.layers[0][index];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a Merkle proof.
 *
 * Given:
 *   - The leaf hash to verify
 *   - The proof (sibling path from leaf to root)
 *   - The expected root hash
 *
 * Recomputes the path and checks it matches the committed root.
 *
 * Time: O(log n) hash operations
 *
 * @param {string}   leafHash     - hex hash of the leaf being verified
 * @param {object[]} proof        - Array of { hash, position } from generateProof()
 * @param {string}   expectedRoot - The committed Merkle root (hex)
 * @returns {boolean}             - true if the proof is valid
 */
export function verifyProof(leafHash, proof, expectedRoot) {
  let current = leafHash;

  for (const step of proof) {
    if (step.position === "left") {
      current = combineHashes(step.hash, current);
    } else {
      current = combineHashes(current, step.hash);
    }
  }

  return current === expectedRoot;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATASET COMMITMENT (Server-side)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Merkle tree over all POIs and return the commitment bundle.
 *
 * The server calls this once per dataset refresh, publishes the root,
 * then uses the tree to generate proofs alongside each query result.
 *
 * @param {object[]} pois      - Full POI dataset
 * @returns {object}           - { root, tree, poiIndex }
 */
export function buildDatasetCommitment(pois) {
  const sortedPois = [...pois].sort((a, b) => a.id.localeCompare(b.id));

  const leafHashes = sortedPois.map(poiLeafHash);
  const tree = new MerkleTree(leafHashes);

  // Build a lookup: poiId → leaf index in the sorted array
  const poiIndex = new Map(sortedPois.map((p, i) => [p.id, i]));

  console.log(
    `[Merkle] Dataset committed — ${pois.length} POIs, root: ${tree.root.slice(0, 16)}...`
  );

  return { root: tree.root, tree, poiIndex, sortedPois };
}

/**
 * Generate Merkle proofs for a set of result POI ids.
 *
 * @param {string[]} resultIds   - POI ids returned by kNN
 * @param {object}   commitment  - From buildDatasetCommitment()
 * @returns {object[]}           - Array of { poiId, leafHash, proof }
 */
export function generateResultProofs(resultIds, commitment) {
  const { tree, poiIndex, sortedPois } = commitment;

  return resultIds.map((id) => {
    const idx = poiIndex.get(id);
    if (idx === undefined) {
      throw new Error(`POI id ${id} not found in committed dataset`);
    }
    const leafHash = poiLeafHash(sortedPois[idx]);
    const proof = tree.generateProof(idx);
    return { poiId: id, leafHash, proof, leafIndex: idx };
  });
}

/**
 * Verify that all result POIs are genuinely in the committed dataset.
 *
 * @param {object[]} proofBundles - From generateResultProofs()
 * @param {object[]} resultPois   - Full POI objects for the results
 * @param {string}   root         - The committed Merkle root
 * @returns {{ valid: boolean, details: object[] }}
 */
export function verifyResults(proofBundles, resultPois, root) {
  const poiMap = new Map(resultPois.map((p) => [p.id, p]));

  const details = proofBundles.map(({ poiId, leafHash, proof }) => {
    const poi = poiMap.get(poiId);
    if (!poi) return { poiId, valid: false, reason: "POI not found in result set" };

    // Recompute the leaf hash from the POI data
    const expectedLeaf = poiLeafHash(poi);
    if (expectedLeaf !== leafHash) {
      return { poiId, valid: false, reason: "Leaf hash mismatch — POI data tampered" };
    }

    // Verify the Merkle path
    const pathValid = verifyProof(leafHash, proof, root);
    return {
      poiId,
      leafHash: leafHash.slice(0, 16) + "...",
      proofDepth: proof.length,
      valid: pathValid,
      reason: pathValid ? "Proof verified" : "Merkle path verification failed",
    };
  });

  return {
    valid: details.every((d) => d.valid),
    root: root.slice(0, 16) + "...",
    details,
  };
}
