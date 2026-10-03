# 🛡️ VEIL — Privacy-Preserving Location-Based kNN System

> A final-year Computer Science project implementing a cryptographically secure
> k-Nearest Neighbours system where the server computes results without ever
> learning the user's GPS coordinates.

---

## 📁 Project Structure

```
veil/
├── backend/                        # Node.js API server
│   ├── server.js                   # Express REST API (7 endpoints)
│   ├── package.json
│   ├── osm/
│   │   └── fetcher.js              # OpenStreetMap Overpass API integration
│   ├── geometry/
│   │   └── knn.js                  # Plain kNN + Haversine + complexity report
│   └── crypto/
│       ├── veil.js                 # VEILSession orchestrator
│       ├── gc/
│       │   └── garbledCircuit.js   # Full garbled circuit: XOR, AND, SUB, SQR, ADD, CMP
│       ├── ot/
│       │   └── obliviousTransfer.js # Naor-Pinkas base OT + IKNP extension
│       └── merkle/
│           └── merkleTree.js       # SHA-256 Merkle tree + proof generation/verification
│
└── frontend/                       # React + Vite SPA
    ├── index.html
    ├── vite.config.js
    ├── tailwind.config.js
    └── src/
        ├── App.jsx                 # Root layout + state
        ├── index.css                # TailwindCSS + VEIL theme
        ├── services/
        │   ├── api.js               # Typed fetch wrappers for all backend calls
        │   └── gcProtocol.js        # Client-side GC protocol — encode, OT-select, evaluate
        └── components/
            ├── Header.jsx           # Top bar with mode indicator
            ├── LandingPage.jsx      # Pre-app landing/intro page
            ├── ControlPanel.jsx     # Left sidebar: mode, k, categories, GPS, query
            ├── MapView.jsx          # Dark Leaflet map with OSM tiles + POI markers
            ├── ThreeScene.jsx       # Three.js 3D floating marker visualization
            ├── ResultPanel.jsx      # kNN results + latency breakdown + Merkle status
            ├── ComplexityPanel.jsx  # Complexity analysis table + gate breakdown
            └── StatusBar.jsx        # Bottom status bar

test/                                # Automated test suite + benchmark (outside backend/frontend)
├── package.json                     # { "type": "module" }
├── run_tests.mjs                    # Full correctness/privacy/candidate/benchmark test suite
└── benchmark.mjs                    # Deterministic plain-vs-secure benchmark (Phase 5)
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js ≥ 18
- Internet access (for OpenStreetMap Overpass API)

### 1. Backend
```bash
cd backend
npm install
node server.js
# → Running on http://localhost:3001
```

### 2. Frontend
```bash
cd frontend
npm install
npm run dev
# → Running on http://localhost:5173
```

Open http://localhost:5173 in your browser.

### 3. Automated tests + benchmark
```bash
cd test
npm install    # no dependencies beyond Node itself — installs nothing
node run_tests.mjs
node benchmark.mjs --lat 12.9716 --lng 77.5946 --k 5 --categories hospital
```

---

## 🔐 Security Architecture Deep Dive

### Why Privacy Matters for Location

Sharing a GPS location with a server reveals far more than just "where you are":
- **Home/work inference** from query patterns over time
- **Religious/medical inference** from nearby POI types (mosque, hospital)
- **Stalking & surveillance** if logs are subpoenaed or breached

VEIL ensures the server computes kNN results **without ever seeing the query coordinates**.

---

### Component 1: Garbled Circuits (Yao 1986)

A garbled circuit is an encrypted version of a boolean circuit. The SERVER (garbler)
encrypts the circuit; the CLIENT (evaluator) runs it on encrypted inputs.

#### Wire Labels
Every circuit wire `w` has two 128-bit labels:
```
W⁰_w  →  encodes logical-0 on wire w
W¹_w  →  encodes logical-1 on wire w
```

**Free-XOR global Δ**: A single random 128-bit value Δ is chosen so that:
```
W¹_w = W⁰_w ⊕ Δ  for every wire w
```
This makes XOR gates completely free (zero ciphertext rows — just XOR labels).

#### Gate Encoding

**XOR gate** (Free-XOR, Kolesnikov & Schneider 2008):
```
W⁰_c = W⁰_a ⊕ W⁰_b
W¹_c = W⁰_c ⊕ Δ   ← automatic from Free-XOR invariant
Evaluator: label_c = label_a ⊕ label_b   (1 XOR, 0 AES calls)
```

**AND gate** (Half-gates, Zahur, Rosulek & Evans 2015):
```
Garbler's half:
  T_g = H(W⁰_a, gid) ⊕ H(W¹_a, gid) ⊕ (p_b · Δ)

Evaluator's half:
  T_e = H(W⁰_b, gid) ⊕ H(W¹_b, gid) ⊕ W⁰_a

Output wire:
  W⁰_c = H(W⁰_a) ⊕ (p_a · T_g) ⊕ H(W⁰_b) ⊕ (p_b · (T_e ⊕ W⁰_a))

Evaluation (2 AES calls):
  s_a = lsb(label_a),  s_b = lsb(label_b)
  W_g = H(label_a) ⊕ (s_a · T_g)
  W_e = H(label_b) ⊕ (s_b · (T_e ⊕ label_a))
  label_c = W_g ⊕ W_e
```

#### kNN Circuit Structure (per POI, 32-bit coords)

```
Client inputs:  x_c[32], y_c[32]   ← delivered via OT
Server inputs:  x_p[32], y_p[32]   ← server injects correct labels

Circuit:
  dx   ← SUB(x_c, x_p)    33-bit ripple-carry subtractor
  dy   ← SUB(y_c, y_p)    66 AND gates total
  dx²  ← SQR(dx)           ~1,024 AND gates (schoolbook squarer)
  dy²  ← SQR(dy)           ~1,024 AND gates
  d²   ← ADD(dx², dy²)     65 AND gates
  out  ← CMP(d², T)        65 AND gates (bitwise comparator)

Total per POI: ~2,244 AND gates + free XOR gates
For n=100:    ~224,400 AND gates = ~448,800 AES calls
```

---

### Component 2: Oblivious Transfer (OT)

OT lets the client obtain the correct wire labels for its input bits
**without the server learning which bit was chosen**.

#### Naor-Pinkas Base OT (single instance)

```
Sender has: (m₀, m₁)
Receiver has: b ∈ {0, 1}

Round 1 (Receiver → Sender):
  Receiver picks random k ∈ Z_q
  If b=0: sends PK₀ = g^k,  PK₁ = C / g^k
  If b=1: sends PK₀ = C/g^k, PK₁ = g^k
  (C is a public group element; sender cannot tell which case it is)

Round 2 (Sender → Receiver):
  For each j ∈ {0,1}: picks rⱼ, sends (g^{rⱼ}, H(PKⱼ^{rⱼ}) ⊕ mⱼ)

Receiver decrypts:
  m_b = E_b.second ⊕ H(g^{r_b}^k)
  (knows k, so can compute PKb^{r_b} = (g^{r_b})^k)
```

#### IKNP OT Extension (Ishai et al. 2003)

Converts κ=128 base OTs into m ≫ 128 extended OTs with only symmetric-key ops:

```
Offline: Sender picks s ∈ {0,1}^κ, runs κ base OTs as receiver
         Gets: q_j = t_j ⊕ (s_j · r)  for each column j

Online (per OT instance i):
  Sender sends:  y₀_i = m₀_i ⊕ H(i, q_i)
                 y₁_i = m₁_i ⊕ H(i, q_i ⊕ s)
  Receiver gets: x_{b_i} = y_{b_i} ⊕ H(i, t_i)

Cost: κ=128 base OTs → unlimited extended OTs via PRG
```

---

### Component 3: Merkle Tree (Result Verification)

After the circuit returns k POI ids, the client verifies they're in the
server's committed dataset:

```
Dataset commitment (before any query):
  leaf_i  = SHA-256(poi.id || lat || lng || name || category)
  tree    = MerkleTree(leaf_0, leaf_1, ..., leaf_n)
  root    = published to client (immutable commitment)

Per-result proof:
  proof_i = [sibling₀, sibling₁, ..., sibling_{log n}]
  Each: { hash: hex, position: 'left' | 'right' }

Verification (client):
  current = leaf_hash
  for step in proof:
    if step.position == 'left':  current = SHA-256(step.hash || current)
    else:                        current = SHA-256(current || step.hash)
  assert current == committed_root   ← O(log n) hashes
```

**Properties:**
- Inclusion proof: returned POI definitely exists in committed dataset
- Tamper detection: server cannot add/remove POIs after root is published
- Lightweight: O(log n) verification regardless of dataset size

---

## 📊 Complexity Analysis

| Metric              | Plain kNN         | Secure kNN (VEIL)      |
|---------------------|-------------------|------------------------|
| Time complexity     | O(n log k)        | O(n · b²) gates        |
| Space (client)      | O(k)              | O(n · b²) labels       |
| Communication       | Full coords sent  | Circuit + OT messages  |
| Privacy             | None              | Semi-honest secure     |
| AES calls (n=100)   | 0                 | ~448,800               |
| Circuit size (n=100)| —                 | ~7.2 MB                |
| Latency (n=100)     | <1 ms             | ~40–80 ms              |
| Base OTs            | —                 | κ = 128                |

Where b = coordinate bit-width (32), n = number of POIs.

**Speed trade-off**: Secure kNN is ~45,000× slower than plain kNN for n=100,
but this is the fundamental cost of hiding the query from the server.
For n ≤ 500 POIs the latency remains under 200ms — acceptable for a query API.

---

## 🌍 OpenStreetMap Integration

The Overpass API query used to fetch Bengaluru POIs:

```
[out:json][timeout:30];
(
  node["amenity"~"hospital|clinic|doctors"](12.8,77.45,13.1,77.75);
  node["amenity"="restaurant"](12.8,77.45,13.1,77.75);
  node["amenity"="pharmacy"](12.8,77.45,13.1,77.75);
  node["amenity"="cafe"](12.8,77.45,13.1,77.75);
);
out body;
```

Data is cached for 30 minutes server-side; refresh via `GET /api/dataset?refresh=true`.

---

## 🔌 API Reference

| Method | Endpoint            | Description                                                    |
|--------|---------------------|------------------------------------------------------------------|
| GET    | /api/health         | Server status and session info                                  |
| GET    | /api/dataset        | Fetch/return POI dataset from OSM                                |
| POST   | /api/knn/plain      | Plain (non-private) kNN query — **receives lat/lng**             |
| POST   | /api/candidates     | Phase 4: location-aware candidate discovery — **receives lat/lng, coarsened server-side to ~1.1km before use** |
| POST   | /api/gc/init        | Secure path step 1 — garble circuit. Accepts `{k, categories, candidateIds}`. **Rejects lat/lng.** |
| POST   | /api/gc/resolve     | Secure path step 2 — resolve result ids to POI data + Merkle proofs. Accepts `{sessionId, resultIds}`. **Rejects lat/lng.** |
| POST   | /api/knn/secure     | **Deprecated — returns 410 Gone.** Superseded by candidates→gc/init→gc/resolve. |
| GET    | /api/complexity     | Theoretical complexity analysis for current dataset              |
| POST   | /api/verify         | Verify a single Merkle proof                                     |
| GET    | /api/ot/benchmark   | Benchmark the (simulated) OT protocol                            |
| POST   | /api/benchmark      | Phase 5: real, measured plain-vs-secure timing comparison — **benchmarking utility, receives lat/lng, separate from the live query path** |
| GET    | /api/poi/:id        | Look up a single POI by id                                       |

### The live secure query path (what the app actually does)

```
1. POST /api/candidates   { latitude, longitude, categories }
   → server coarsens location to ~1.1km, ranks dataset by distance,
     returns { candidateIds, candidates }

2. POST /api/gc/init       { k, categories, candidateIds }   ← NO coordinates
   → server garbles a circuit over exactly those candidates,
     returns { sessionId, garbledGates, clientWirePairs, ... }

3. [Client evaluates the circuit locally — SubtleCrypto AES-CBC, no network]

4. POST /api/gc/resolve    { sessionId, resultIds }          ← NO coordinates
   → server returns POI metadata + Merkle proofs for those ids
```

### Example: Plain (non-private) query
```bash
curl -X POST http://localhost:3001/api/knn/plain \
  -H "Content-Type: application/json" \
  -d '{"latitude": 12.9716, "longitude": 77.5946, "k": 5, "categories": ["hospital", "cafe"]}'
```

### Example: Candidate discovery (Phase 4)
```bash
curl -X POST http://localhost:3001/api/candidates \
  -H "Content-Type: application/json" \
  -d '{"latitude": 12.9716, "longitude": 77.5946, "categories": ["hospital"]}'
```

---

## 📍 Candidate Discovery vs Secure Computation (Phase 4)

**The bug this replaced:** the secure circuit used to be built from
`pois.filter(category).slice(0, MAX_SECURE_POIS)` — the first N POIs in
whatever arbitrary order OSM/Overpass returned them in, with *zero*
relationship to the querying user's location. A user could receive distant
POIs while genuinely closer ones were never considered, simply because they
weren't early in that array.

**The fix:** `POST /api/candidates` ranks the full cached dataset by actual
distance from the user's location and returns the nearest matches. Those
candidate ids — not raw coordinates — are what `/api/gc/init` uses to build
the circuit.

**The honest privacy trade-off — read this before claiming anything about
VEIL's privacy in a report or demo:**

- `/api/candidates` **does** receive your location over the network.
- The server coarsens it to a **~1.1km × 1.1km grid cell** (rounded to 2
  decimal places) before using or logging it, regardless of what precision
  was actually sent — so it never stores or acts on your exact position.
- `/api/gc/init` and `/api/gc/resolve` are **unaffected** — they still
  reject raw coordinates entirely, coarse or exact, and only ever see
  `{k, categories, candidateIds}` / `{sessionId, resultIds}`.
- **Correct claim:** "the secure computation never receives any location
  data." **Incorrect claim:** "the server never learns anything about your
  location" — it learns your approximate ~1.1km area during candidate
  discovery. Say the true version.

---

## ⏱️ Benchmark Methodology (Phase 5)

Two ways to measure real (never hardcoded or estimated) plain-vs-secure
timings:

1. **`POST /api/benchmark`** — a dedicated evaluation endpoint, separate from
   the live query path above (the app's real search flow never calls it).
   It measures candidate discovery, plain kNN, and circuit garbling
   server-side, and returns those real numbers plus dataset/candidate sizes.
   It does **not** measure client-side circuit *evaluation* time — see why
   in the comment above that route in `backend/server.js` (measuring it
   there would mean the server evaluating its own circuit, which defeats the
   property being benchmarked).

2. **`node test/benchmark.mjs [--lat X --lng Y --k N --categories a,b]`** —
   a deterministic, reproducible, full-pipeline benchmark: candidate
   discovery → plain kNN → garbling → an independent client-side evaluation
   (Node's `crypto.webcrypto`, the same SubtleCrypto interface a browser
   exposes — not a literal browser, see the file's header comment) → resolve
   → Merkle verification, all timed with real `performance.now()` calls. It
   tries live OSM data first and falls back to a small, clearly-labelled
   synthetic fixture if that's unavailable, and says which one it used.

**Why plain and secure timings aren't directly comparable as "workloads":**
plain kNN searches the *entire* category-filtered dataset; secure VEIL kNN
computes only over the location-aware *candidate* subset
(`MAX_SECURE_POIS`, default 30). Both endpoints/scripts report both dataset
sizes explicitly for this reason — don't quote a speed ratio without also
quoting the two sizes it was measured at.

**Correctness check performed by both:** plain kNN run over the *same*
candidate set the secure circuit used, compared to the secure circuit's
own output — not a post-hoc plaintext re-sort of the secure results, which
would defeat the purpose of the secure computation.

---

## 🔮 Extensions & Future Work

1. **Malicious Security**: Add cut-and-choose (Lindell & Pinkas) to handle cheating garbler
2. **ORAM**: Replace plaintext POI reveal with Oblivious RAM so server doesn't learn k ids
3. **Multi-party**: Extend to 3-party setting with a non-colluding helper server
4. **WASM Client**: Compile garbled circuit evaluator to WASM for true client-side evaluation
5. **Batching**: Process multiple queries simultaneously with amortised garbling
6. **Spatial Index**: Apply R-tree partitioning to reduce circuit size for large n

---

## 📚 References

- Yao, A.C. (1986). *How to generate and exchange secrets*. FOCS.
- Kolesnikov & Schneider (2008). *Improved garbled circuit: Free XOR gates*. ICALP.
- Zahur, Rosulek & Evans (2015). *Two halves make a whole: Reducing garbling overhead*. EUROCRYPT.
- Naor & Pinkas (2001). *Efficient oblivious transfer protocols*. SODA.
- Ishai, Kilian, Nissim & Petrank (2003). *Extending oblivious transfers efficiently*. CRYPTO.
- Wong, Cheung & Kao (2009). *Secure kNN computation on encrypted databases*. SIGMOD.

---

*Built as a final-year CS project demonstrating applied cryptography in real geographic systems.*
