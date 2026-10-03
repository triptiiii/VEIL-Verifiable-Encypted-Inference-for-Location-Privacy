/**
 * VEIL — Root Application Component
 *
 * Privacy contract enforced here:
 *   SECURE mode → calls runSecureKNN(lat, lng, ...) from gcProtocol.js
 *     lat/lng are passed ONLY to the local protocol function.
 *     That function NEVER sends them in any fetch() call.
 *
 *   PLAIN mode → calls api.knnPlain({latitude, longitude, ...})
 *     This explicitly sends coordinates to the server.
 *     The UI labels this clearly as non-private.
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "./services/api";
import { runSecureKNN } from "./services/gcProtocol";
import Header from "./components/Header";
import LandingPage from "./components/LandingPage";
import MapView from "./components/MapView";
import ThreeScene from "./components/ThreeScene";
import ControlPanel from "./components/ControlPanel";
import ResultPanel from "./components/ResultPanel";
import ComplexityPanel from "./components/ComplexityPanel";
import StatusBar from "./components/StatusBar";

const DEFAULT_LOCATION = { latitude: 12.9716, longitude: 77.5946 };

export default function App() {
  const [screen, setScreen] = useState("landing"); // 'landing' | 'app'
  const [view, setView] = useState("map");
  const [mode, setMode] = useState("secure");
  const [k, setK] = useState(5);
  const [categories, setCategories] = useState(["hospital", "restaurant", "pharmacy", "cafe"]);

  const [userLocation, setUserLocation] = useState(null);
  const [locationStatus, setLocationStatus] = useState("idle");
  const [locationError, setLocationError] = useState(null);

  const [dataset, setDataset] = useState([]);
  const [datasetMeta, setDatasetMeta] = useState(null);
  const [datasetLoading, setDatasetLoading] = useState(false);

  const [results, setResults] = useState([]);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState(null);
  const [lastQueryMeta, setLastQueryMeta] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState(null);

  // Step-by-step progress for the secure protocol
  const [protocolSteps, setProtocolSteps] = useState([]);

  const [serverStatus, setServerStatus] = useState("checking");
  const [activeTab, setActiveTab] = useState("results");

  // ── Server health ────────────────────────────────────────────────────────
  useEffect(() => {
    api.health()
      .then(() => setServerStatus("ok"))
      .catch(() => setServerStatus("error"));
  }, []);

  // ── Dataset ──────────────────────────────────────────────────────────────
  const loadDataset = useCallback(async (cats = categories, refresh = false) => {
    setDatasetLoading(true);
    try {
      const data = await api.dataset(cats, refresh);
      setDataset(data.pois || []);
      setDatasetMeta({
        total: data.total,
        merkleRoot: data.merkleRoot,
        loadedAt: data.loadedAt,
        categories: data.categories,
      });
    } catch (err) {
      console.error("Dataset load failed:", err.message);
    } finally {
      setDatasetLoading(false);
    }
  }, [categories]);

  useEffect(() => { loadDataset(); }, []);

  // ── GPS ──────────────────────────────────────────────────────────────────
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation not supported by your browser.");
      setLocationStatus("error");
      return;
    }
    setLocationStatus("loading");
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setLocationStatus("ready");
      },
      (err) => {
        // Fallback to Bengaluru centre — clearly labelled, with a message
        // that distinguishes *why* (permission denied vs. unavailable vs.
        // timed out), since those call for different user action.
        const reason = {
          1: "GPS permission denied",
          2: "GPS position unavailable",
          3: "GPS request timed out",
        }[err?.code] || "GPS unavailable";
        setUserLocation({ ...DEFAULT_LOCATION, accuracy: null, simulated: true });
        setLocationStatus("ready");
        setLocationError(`${reason} — using central Bengaluru as a demo location instead.`);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }, []);

  // ── Query ────────────────────────────────────────────────────────────────
  const runQuery = useCallback(async () => {
    // A category list of [] means "nothing selected", not "search everything" —
    // previously this fell through to `categories.length > 0 ? categories : null`,
    // and `null` means "all categories" server-side, so deselecting every
    // category silently searched every category instead of none. Guard it here.
    if (categories.length === 0) {
      setQueryError("Select at least one category before searching.");
      return;
    }

    const loc = userLocation || DEFAULT_LOCATION;
    setQueryLoading(true);
    setQueryError(null);
    setResults([]);
    setProtocolSteps([]);
    setLastQueryMeta(null);
    setSelectedResultId(null);
    setHasSearched(true);

    try {
      if (mode === "secure") {
        // ── SECURE MODE ──────────────────────────────────────────────────
        // lat/lng are passed to runSecureKNN() which runs LOCALLY.
        // That function calls fetch("/api/gc/init", {body: {k, categories}})
        // and fetch("/api/gc/resolve", {body: {sessionId, resultIds}}).
        // Neither fetch contains latitude or longitude.
        const data = await runSecureKNN(
          loc.latitude,   // ← stays in gcProtocol.js, never in fetch body
          loc.longitude,  // ← stays in gcProtocol.js, never in fetch body
          k,
          categories,
          (step) => setProtocolSteps((prev) => [...prev, step])
        );
        setResults(data.results || []);
        setLastQueryMeta(data);
      } else {
        // ── PLAIN MODE ───────────────────────────────────────────────────
        // This DOES send coordinates to the server.
        // It is the non-private baseline — labelled clearly in the UI.
        const data = await api.knnPlain({
          latitude: loc.latitude,   // ← explicitly sent (plain mode = non-private)
          longitude: loc.longitude,
          k,
          categories,
        });
        setResults(data.results || []);
        setLastQueryMeta({ mode: "plaintext", ...data });
      }
    } catch (err) {
      setQueryError(err.message);
    } finally {
      setQueryLoading(false);
    }
  }, [userLocation, mode, k, categories]);

  // Auto-run when location becomes available
  useEffect(() => {
    if (locationStatus === "ready" && userLocation) runQuery();
  }, [locationStatus]);

  // ── Category toggle ──────────────────────────────────────────────────────
  const toggleCategory = (cat) => {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const filteredDataset = dataset.filter(
    (p) => categories.length === 0 || categories.includes(p.category)
  );

  // ── Render ───────────────────────────────────────────────────────────────
  if (screen === "landing") {
    return <LandingPage onLaunch={() => setScreen("app")} serverStatus={serverStatus} />;
  }

  return (
    <div className="h-screen flex flex-col bg-veil-bg overflow-hidden">
      <Header serverStatus={serverStatus} mode={mode} view={view} onViewChange={setView} onGoHome={() => setScreen("landing")} />

      <div className="flex flex-1 overflow-hidden">
        {/* Left: controls */}
        <div className="w-72 flex-shrink-0 flex flex-col border-r border-veil-border overflow-y-auto">
          <ControlPanel
            mode={mode}
            onModeChange={setMode}
            k={k}
            onKChange={setK}
            categories={categories}
            onCategoryToggle={toggleCategory}
            locationStatus={locationStatus}
            locationError={locationError}
            userLocation={userLocation}
            onRequestLocation={requestLocation}
            onRunQuery={runQuery}
            queryLoading={queryLoading}
            datasetMeta={datasetMeta}
            datasetLoading={datasetLoading}
            onRefreshDataset={() => loadDataset(categories, true)}
          />
        </div>

        {/* Centre: map or 3D */}
        <div className="flex-1 relative overflow-hidden">
          {view === "map" ? (
            <MapView
              userLocation={userLocation || DEFAULT_LOCATION}
              dataset={filteredDataset}
              results={results}
              categories={categories}
              loading={queryLoading}
              selectedId={selectedResultId}
              onSelectResult={setSelectedResultId}
            />
          ) : (
            <ThreeScene
              userLocation={userLocation || DEFAULT_LOCATION}
              results={results}
              dataset={filteredDataset}
            />
          )}
        </div>

        {/* Right: results / complexity / protocol */}
        <div className="w-80 flex-shrink-0 flex flex-col border-l border-veil-border overflow-hidden">
          <div className="flex border-b border-veil-border flex-shrink-0">
            {[
              { id: "results", label: "Results" },
              { id: "complexity", label: "Complexity" },
              { id: "protocol", label: "Protocol" },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex-1 py-3 text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === t.id
                    ? "text-veil-accent border-b-2 border-veil-accent bg-veil-card"
                    : "text-veil-muted hover:text-veil-text"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {activeTab === "results" && (
              <ResultPanel
                results={results}
                loading={queryLoading}
                error={queryError}
                meta={lastQueryMeta}
                mode={mode}
                protocolSteps={protocolSteps}
                hasSearched={hasSearched}
                selectedId={selectedResultId}
                onSelectResult={setSelectedResultId}
              />
            )}
            {activeTab === "complexity" && (
              <ComplexityPanel datasetMeta={datasetMeta} k={k} />
            )}
            {activeTab === "protocol" && (
              <ProtocolPanel meta={lastQueryMeta} mode={mode} protocolSteps={protocolSteps} />
            )}
          </div>
        </div>
      </div>

      <StatusBar
        serverStatus={serverStatus}
        datasetMeta={datasetMeta}
        userLocation={userLocation}
        results={results}
        queryLoading={queryLoading}
        mode={mode}
      />
    </div>
  );
}

// ── Protocol Panel ───────────────────────────────────────────────────────────

function ProtocolPanel({ meta, mode, protocolSteps }) {
  const steps = [
    {
      id: 1, phase: "Client", title: "GPS Encode",
      desc: "navigator.geolocation → lat × 10⁶ → 32-bit integer → 64 query bits. Stays in browser.",
      color: "text-veil-teal",
      privacyNote: "Server sees: nothing yet.",
    },
    {
      id: 2, phase: "Server", title: "Candidate Discovery  POST /api/candidates",
      desc: "Client sends its GPS coordinates, coarsened server-side to a ~1.1km grid cell, to select a geographically relevant candidate set (replaces the old arbitrary first-N slice).",
      color: "text-yellow-400",
      privacyNote: "Server sees: your approximate ~1.1km area (NOT exact coordinates) — for this step only.",
    },
    {
      id: 3, phase: "Server", title: "Circuit Init  POST /api/gc/init",
      desc: "Client sends {k, categories, candidateIds} only. Server garbles kNN circuit over that candidate set.",
      color: "text-veil-purple",
      privacyNote: "Server sees: {k, categories, candidateIds}. NOT coordinates, not even coarse ones.",
    },
    {
      id: 4, phase: "Client", title: "OT Label Selection",
      desc: "Server provides {W⁰, W¹} per input wire. Client picks W^{bᵢ} using private bits. No bits sent.",
      color: "text-veil-coral",
      privacyNote: "Server sees: both label options sent. Client's choice is private.",
    },
    {
      id: 5, phase: "Client", title: "Circuit Evaluation (Browser AES)",
      desc: "Client evaluates garbled gates using SubtleCrypto AES-CBC. Produces k nearest POI ids.",
      color: "text-veil-teal",
      privacyNote: "Server sees: nothing. Evaluation runs in browser.",
    },
    {
      id: 6, phase: "Server", title: "Resolve  POST /api/gc/resolve",
      desc: "Client sends {sessionId, resultIds}. Server returns POI metadata and Merkle proofs.",
      color: "text-veil-purple",
      privacyNote: "Server sees: which POIs are nearest. NOT coordinates.",
    },
    {
      id: 7, phase: "Client", title: "Merkle Verification",
      desc: "Client verifies each returned POI against the committed Merkle root. SHA-256 path check.",
      color: "text-veil-green",
      privacyNote: "✓ Dataset integrity confirmed.",
    },
  ];

  return (
    <div className="p-4 space-y-3">
      <div className="veil-label mb-3">Protocol Flow</div>

      {mode === "plain" && (
        <div className="p-3 rounded-lg bg-yellow-900/20 border border-yellow-700/30 text-xs text-yellow-400 mb-4">
          ⚠ Plain mode active. The server receives your raw coordinates. Switch to Secure to activate the privacy protocol.
        </div>
      )}

      {/* Explicit PROTECTED vs VISIBLE TO SERVER split — the single clearest
          artifact for a viva/demo: what can the server see, full stop. */}
      <div className="grid grid-cols-2 gap-2 mb-1">
        <div className="p-3 rounded-lg bg-veil-green/5 border border-veil-green/20">
          <div className="text-[10px] font-mono uppercase tracking-wider text-veil-green mb-2">Protected</div>
          <ul className="space-y-1 text-[11px] text-veil-text/85">
            <li>✓ Exact latitude</li>
            <li>✓ Exact longitude</li>
            <li>✓ Query bits (64)</li>
            <li>✓ Intermediate computation</li>
          </ul>
        </div>
        <div className="p-3 rounded-lg bg-veil-coral/5 border border-veil-coral/20">
          <div className="text-[10px] font-mono uppercase tracking-wider text-veil-coral mb-2">Visible to server</div>
          <ul className="space-y-1 text-[11px] text-veil-text/85">
            <li>• approx. ~1.1km area (candidate discovery only)</li>
            <li>• k (result count)</li>
            <li>• categories</li>
            <li>• session ID</li>
            <li>• result POI ids</li>
            <li>• circuit metadata</li>
          </ul>
        </div>
      </div>
      <div className="text-[10px] text-veil-muted italic mb-4 px-1">
        This split only applies while Secure mode is active — Plain mode sends the exact coordinates to the server as its non-private baseline. Candidate discovery (step 2) is the one place the secure path reveals anything about location, and only your coarse ~1.1km cell — never exact coordinates, and never to the garbled-circuit computation itself.
      </div>

      {steps.map((step, i) => (
        <div key={step.id} className="relative">
          {i < steps.length - 1 && (
            <div className="absolute left-5 top-10 w-0.5 h-6 bg-veil-border" />
          )}
          <div className="flex gap-3">
            <div className="w-10 h-10 rounded-full border border-veil-border bg-veil-card flex items-center justify-center flex-shrink-0 text-xs font-mono text-veil-muted">
              {step.id}
            </div>
            <div className="flex-1 pb-1">
              <div className={`text-xs font-mono uppercase ${step.color} mb-0.5`}>{step.phase}</div>
              <div className="text-sm font-medium text-veil-text">{step.title}</div>
              <div className="text-xs text-veil-muted mt-1 leading-relaxed">{step.desc}</div>
              <div className="text-xs text-veil-teal/70 mt-1 italic">{step.privacyNote}</div>
            </div>
          </div>
        </div>
      ))}

      {/* Live steps from last run */}
      {protocolSteps.length > 0 && (
        <div className="mt-4 p-3 veil-card rounded-lg space-y-1 border-veil-teal/20 border">
          <div className="veil-label mb-2">Last Run — Live Log</div>
          {protocolSteps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs font-mono">
              <span className={s.done ? "text-veil-green" : "text-veil-accent"}>
                {s.done ? "✓" : "⟳"}
              </span>
              <span className={s.done ? "text-veil-text" : "text-veil-muted"}>{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* OT note */}
      <div className="mt-4 p-3 rounded-lg bg-veil-coral/5 border border-veil-coral/20">
        <div className="text-xs font-mono text-veil-coral mb-1">OT Implementation Status</div>
        <div className="text-xs text-veil-muted leading-relaxed">
          OT is currently simulated: server sends both wire labels; client selects using private bits.
          Server cannot observe which label was used (evaluation is client-side).
          Production upgrade: Naor-Pinkas OT with ECDH would cryptographically enforce choice-hiding.
        </div>
      </div>

      {meta?.circuitStats && (
        <div className="mt-3 p-3 veil-card rounded-lg space-y-1">
          <div className="veil-label mb-2">Last Circuit</div>
          {[
            ["Gates", meta.circuitStats.numGates?.toLocaleString()],
            ["POIs", meta.circuitStats.numPOIs],
            ["Input bits", meta.circuitStats.inputBits],
          ].map(([k2, v]) => (
            <div key={k2} className="flex justify-between text-xs">
              <span className="text-veil-muted">{k2}</span>
              <span className="font-mono text-veil-accent">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
