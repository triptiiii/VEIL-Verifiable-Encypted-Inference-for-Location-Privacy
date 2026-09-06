/**
 * VEIL — kNN Geometry Module
 *
 * Implements k-Nearest Neighbours search over geographic POIs.
 *
 * ─────────────────────────────────────────────────────
 * ALGORITHM SELECTION & COMPLEXITY
 * ─────────────────────────────────────────────────────
 *
 * Baseline (plain) kNN:
 *   - For each POI, compute Euclidean distance² to the query point.
 *   - Maintain a max-heap of size k.
 *   - If current distance < heap max → replace heap top.
 *   - Time:  O(n log k)   (n comparisons, each heap op is O(log k))
 *   - Space: O(k)         (only the heap, not the full distance array)
 *
 * Geographic distance note:
 *   On the scale of a city (~20 km radius), projecting lat/lng to a
 *   flat Cartesian plane introduces <0.3% error. We therefore use
 *   the Haversine formula for the *reported* display distance (metres),
 *   and the squared flat-plane distance (no sqrt) for comparisons inside
 *   the kNN heap (same rank order, avoids expensive sqrt).
 *
 * For the SECURE kNN path, the circuit takes integer-encoded coordinates
 * (scaled to microdegrees: lat × 1e6, lng × 1e6), computes:
 *     dist² = (x_c − x_p)² + (y_c − y_p)²
 * using the garbled circuit, then returns the k POI ids whose dist²
 * values were smallest (comparison done via CMP circuit gate).
 *
 * ─────────────────────────────────────────────────────
 * DATA STRUCTURES
 * ─────────────────────────────────────────────────────
 *
 * Point:
 *   { x: number, y: number }
 *   x = latitude, y = longitude (float degrees OR integer microdegrees)
 *
 * POI:
 *   { id, name, category, latitude, longitude, tags }
 *
 * HeapEntry:
 *   { poi: POI, distSquared: number, distMetres: number }
 *   Heap is a max-heap on distSquared so we can efficiently find & evict
 *   the current k-th nearest candidate.
 *
 * ─────────────────────────────────────────────────────
 */

/**
 * Compute the Haversine great-circle distance in metres between two
 * geographic points.  Used for accurate distance display after ranking.
 *
 * Haversine formula:
 *   a = sin²(Δlat/2) + cos(lat1) × cos(lat2) × sin²(Δlng/2)
 *   c = 2 × atan2(√a, √(1−a))
 *   d = R × c
 *
 * Time: O(1)
 *
 * @param {number} lat1 - degrees
 * @param {number} lng1 - degrees
 * @param {number} lat2 - degrees
 * @param {number} lng2 - degrees
 * @returns {number} distance in metres
 */
export function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6_371_000; // Earth radius, metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  // Rounded to the nearest metre to match the client's haversineMetres()
  // (frontend/src/services/gcProtocol.js) — previously these diverged in
  // precision (server returned an unrounded float), which meant the plain
  // baseline and the secure path displayed distances differently for the
  // same two points. Fixed during the polish sprint (see README §16).
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * Squared flat-plane distance (no sqrt).
 * Coordinates are treated as Cartesian (sufficient for city-scale).
 * Uses degree values directly; result has no physical unit but rank-order
 * is identical to metric distance rank-order for a small region.
 *
 * Time: O(1)
 */
function squaredFlatDistance(lat1, lng1, lat2, lng2) {
  const dx = lat1 - lat2;
  const dy = lng1 - lng2;
  return dx * dx + dy * dy;
}

// ─────────────────────────────────────────────────────
// MAX-HEAP (keyed on distSquared)
// ─────────────────────────────────────────────────────

class MaxHeap {
  constructor() {
    this._data = []; // array-based binary heap
  }

  get size() {
    return this._data.length;
  }

  peek() {
    return this._data[0] ?? null;
  }

  /**
   * Insert an element.  If the heap grows beyond capacity, call pop()
   * from the outside (caller manages the capacity invariant).
   * Time: O(log n)
   */
  push(entry) {
    this._data.push(entry);
    this._bubbleUp(this._data.length - 1);
  }

  /**
   * Remove and return the maximum element.
   * Time: O(log n)
   */
  pop() {
    const top = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0) {
      this._data[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._data[parent].distSquared >= this._data[i].distSquared) break;
      [this._data[parent], this._data[i]] = [this._data[i], this._data[parent]];
      i = parent;
    }
  }

  _siftDown(i) {
    const n = this._data.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this._data[left].distSquared > this._data[largest].distSquared)
        largest = left;
      if (right < n && this._data[right].distSquared > this._data[largest].distSquared)
        largest = right;
      if (largest === i) break;
      [this._data[largest], this._data[i]] = [this._data[i], this._data[largest]];
      i = largest;
    }
  }

  /**
   * Return all elements sorted ascending by distSquared.
   * Does NOT mutate the heap.
   */
  sortedAscending() {
    return [...this._data].sort((a, b) => a.distSquared - b.distSquared);
  }
}

// ─────────────────────────────────────────────────────
// PLAIN kNN (Baseline)
// ─────────────────────────────────────────────────────

/**
 * Plain (unsecured) k-Nearest Neighbours search.
 *
 * Algorithm (max-heap approach):
 *   1. Initialise an empty max-heap H of capacity k.
 *   2. For each POI p in the dataset:
 *        d² ← squaredFlatDistance(query, p)
 *        If |H| < k:   push (p, d²) onto H
 *        Else if d² < H.peek().d²:
 *                pop H.max, push (p, d²)
 *   3. Return H sorted ascending → k nearest POIs.
 *
 * Time:  O(n log k)  where n = |pois|
 * Space: O(k)        heap only
 *
 * @param {object}   query           - { latitude, longitude }
 * @param {object[]} pois            - Full POI dataset
 * @param {number}   k               - Number of neighbours (default 5)
 * @param {string[]} [filterCats]    - Restrict to these categories
 * @returns {object[]}               - k nearest, sorted ascending, with distMetres
 */
export function plainKNN(query, pois, k = 5, filterCats = null) {
  const qLat = query.latitude;
  const qLng = query.longitude;

  const dataset = filterCats
    ? pois.filter((p) => filterCats.includes(p.category))
    : pois;

  const heap = new MaxHeap();

  for (const poi of dataset) {
    const d2 = squaredFlatDistance(qLat, qLng, poi.latitude, poi.longitude);
    const entry = { poi, distSquared: d2 };

    if (heap.size < k) {
      heap.push(entry);
    } else if (d2 < heap.peek().distSquared) {
      heap.pop();
      heap.push(entry);
    }
  }

  // Compute accurate Haversine distances on the final k candidates only
  return heap.sortedAscending().map((entry) => ({
    ...entry.poi,
    distMetres: Math.round(
      haversineMetres(qLat, qLng, entry.poi.latitude, entry.poi.longitude)
    ),
    distSquared: entry.distSquared,
    privacyMode: "plaintext",
  }));
}

// ─────────────────────────────────────────────────────
// SECURE kNN POST-PROCESSING
// ─────────────────────────────────────────────────────

/**
 * After the garbled-circuit evaluation returns a list of POI ids and
 * their (encrypted) distance values, this function enriches those ids
 * with full POI metadata and computes display distances.
 *
 * The SERVER never calls this with the real query location — only the
 * decrypted circuit output (which POI ids won) is passed from client
 * to this enrichment step.
 *
 * @param {string[]} resultIds   - POI ids returned by secure evaluation
 * @param {object[]} pois        - Full POI dataset (server-side)
 * @param {object}   queryPoint  - { latitude, longitude } — provided by CLIENT after reveal
 * @returns {object[]}           - Enriched result objects
 */
export function enrichSecureResults(resultIds, pois, queryPoint) {
  const poiMap = new Map(pois.map((p) => [p.id, p]));

  return resultIds
    .map((id) => {
      const poi = poiMap.get(id);
      if (!poi) return null;
      return {
        ...poi,
        distMetres: Math.round(
          haversineMetres(
            queryPoint.latitude,
            queryPoint.longitude,
            poi.latitude,
            poi.longitude
          )
        ),
        privacyMode: "secure",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distMetres - b.distMetres);
}

// ─────────────────────────────────────────────────────
// COMPLEXITY REPORT
// ─────────────────────────────────────────────────────

/**
 * Generate a complexity analysis report for both plain and secure kNN.
 *
 * @param {number} n - Number of POIs
 * @param {number} k - Number of neighbours
 * @param {number} b - Coordinate bit-width (default 32)
 * @returns {object} - Detailed report
 */
export function complexityReport(n, k, b = 32) {
  // Plain kNN
  const plainComparisons = n;
  const plainHeapOps = n; // at most n pushes
  const plainTimeOps = n * Math.ceil(Math.log2(k) || 1);

  // Secure kNN (garbled circuit)
  // SUB: 2 × (b+1) AND gates (ripple-carry subtractor)
  // SQR: b² AND gates (schoolbook squarer, each partial product is one AND)
  // ADD: (2b+1) AND gates
  // CMP: (2b+1) AND gates
  const gatesPerPOI = 2 * (b + 1) + 2 * b * b + (2 * b + 1) + (2 * b + 1);
  const totalAndGates = n * gatesPerPOI;
  const aesCallsPerGate = 2; // half-gate garbling
  const totalAESCalls = totalAndGates * aesCallsPerGate;

  // OT complexity: n×b base OTs using IKNP extension
  // IKNP extension: b base OTs → unlimited extended OTs with cheap computation
  const baseOTs = b; // one per input wire bit
  const otMessagesBytes = n * b * 16; // 16-byte labels each

  // Communication (bytes)
  // Each AND gate: 2 × 16 bytes (two ciphertext rows in half-gate scheme)
  const circuitBytes = totalAndGates * 2 * 16;
  const otBytes = otMessagesBytes;
  const totalCommBytes = circuitBytes + otBytes;

  return {
    input: { n, k, b },
    plainKNN: {
      timeComplexity: `O(n log k) = O(${n} × log ${k})`,
      concreteOps: plainTimeOps,
      spaceComplexity: `O(k) = O(${k}) heap entries`,
      communicationBytes: "Full dataset exposed to server",
      privacyLevel: "None — server sees query coordinates",
    },
    secureKNN: {
      gatesPerPOI,
      totalAndGates,
      totalXORGates: `~${Math.round(totalAndGates * 0.6)} (free with Free-XOR)`,
      totalAESCalls,
      garbleTimeMs: `~${(totalAESCalls * 1e-7 * 1000).toFixed(1)} ms (estimate, modern CPU)`,
      circuitTransferKB: (circuitBytes / 1024).toFixed(1),
      otTransferKB: (otBytes / 1024).toFixed(1),
      totalTransferKB: (totalCommBytes / 1024).toFixed(1),
      baseOTsRequired: baseOTs,
      privacyLevel: "Computational — server learns nothing beyond circuit output",
      securityModel: "Semi-honest (honest-but-curious) adversary",
    },
    comparison: {
      speedRatio: `Plain is ~${Math.round(totalAESCalls / plainTimeOps)}× faster`,
      privacyTradeoff: "Secure path hides query location at cost of garbling overhead",
      recommended: n <= 500 ? "Use secure path (feasible latency)" : "Use secure path with spatial partitioning",
    },
  };
}
