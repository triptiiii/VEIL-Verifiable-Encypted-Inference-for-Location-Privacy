/**
 * VEIL — Landing Page
 *
 * Previously missing entirely (Phase 8, "not started" in the migration
 * handoff) — the app dropped straight into the technical workspace.
 * This is the first thing a professor/examiner sees before "Launch Secure
 * Search" takes them into the main application.
 */

const FEATURES = [
  {
    icon: '◈',
    title: 'Privacy',
    color: 'text-veil-teal',
    border: 'border-veil-teal/25',
    glow: 'shadow-[0_0_30px_-10px_rgba(0,229,192,0.35)]',
    desc: 'Your exact coordinates never leave your browser. The server only ever sees a category filter, a k value, and the ids of the results it returns.',
  },
  {
    icon: '⧉',
    title: 'Secure Computation',
    color: 'text-veil-accent',
    border: 'border-veil-accent/25',
    glow: 'shadow-[0_0_30px_-10px_rgba(0,198,255,0.35)]',
    desc: 'Nearest-neighbour distances are computed with a garbled boolean circuit that your browser evaluates locally — the server garbles it without knowing your location.',
  },
  {
    icon: '▦',
    title: 'Dataset Integrity',
    color: 'text-veil-purple',
    border: 'border-veil-purple/25',
    glow: 'shadow-[0_0_30px_-10px_rgba(124,58,237,0.35)]',
    desc: 'Every result ships with a Merkle proof, so your browser can verify it genuinely belongs to the committed POI dataset — independent of location privacy.',
  },
  {
    icon: '◎',
    title: 'Real OpenStreetMap Data',
    color: 'text-veil-coral',
    border: 'border-veil-coral/25',
    glow: 'shadow-[0_0_30px_-10px_rgba(249,115,22,0.35)]',
    desc: 'Hospitals, restaurants, pharmacies and cafés are fetched live from the Overpass API for Bengaluru — no fabricated or placeholder listings.',
  },
]

export default function LandingPage({ onLaunch, serverStatus }) {
  return (
    <div className="h-screen overflow-y-auto bg-veil-bg text-veil-text relative">
      {/* Ambient background grid */}
      <div
        className="absolute inset-0 opacity-[0.07] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(#00c6ff 1px, transparent 1px), linear-gradient(90deg, #00c6ff 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-veil-accent/10 blur-[140px] rounded-full pointer-events-none" />

      <div className="relative max-w-5xl mx-auto px-6 pt-20 pb-16">
        {/* Server status pill */}
        <div className="flex justify-center mb-10">
          <div
            className={`px-3 py-1 rounded-full text-xs font-mono flex items-center gap-2 border ${
              serverStatus === 'ok'
                ? 'border-veil-green/30 text-veil-green bg-veil-green/5'
                : serverStatus === 'error'
                ? 'border-red-800/40 text-red-400 bg-red-900/10'
                : 'border-veil-border text-veil-muted'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                serverStatus === 'ok' ? 'bg-veil-green' : serverStatus === 'error' ? 'bg-red-500' : 'bg-yellow-500'
              }`}
            />
            {serverStatus === 'ok'
              ? 'Backend connected'
              : serverStatus === 'error'
              ? 'Backend unreachable'
              : 'Checking backend…'}
          </div>
        </div>

        {/* Brand mark */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-veil-accent to-veil-purple flex items-center justify-center mb-6 shadow-[0_0_50px_-10px_rgba(0,198,255,0.5)]">
            <svg width="30" height="30" viewBox="0 0 16 16" fill="none">
              <path d="M8 1L14 4.5V11.5L8 15L2 11.5V4.5L8 1Z" stroke="white" strokeWidth="1.1" fill="none" />
              <circle cx="8" cy="8" r="2" fill="white" />
            </svg>
          </div>

          <div className="text-sm font-mono uppercase tracking-[0.3em] text-veil-accent mb-3">VEIL</div>
          <h1 className="text-3xl md:text-4xl font-semibold text-white leading-tight max-w-2xl">
            Privacy-Preserving Location-Based
            <br />
            k-Nearest Neighbours
          </h1>
          <p className="mt-5 text-veil-text/80 max-w-xl leading-relaxed">
            Find nearby places without exposing your exact location to the server.
          </p>

          <button
            onClick={onLaunch}
            className="mt-9 veil-btn-primary px-7 py-3 text-sm tracking-wide flex items-center gap-2"
          >
            Launch Secure Search
            <span aria-hidden>→</span>
          </button>
        </div>

        {/* Feature cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-16">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className={`veil-card p-5 ${f.border} ${f.glow} transition-transform hover:-translate-y-0.5`}
            >
              <div className={`text-2xl mb-3 ${f.color}`}>{f.icon}</div>
              <div className="text-sm font-semibold text-white mb-1.5">{f.title}</div>
              <div className="text-xs text-veil-muted leading-relaxed">{f.desc}</div>
            </div>
          ))}
        </div>

        {/* How it works, condensed */}
        <div className="veil-card p-6 mt-10">
          <div className="veil-label mb-4">How a secure query works</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-3 text-xs font-mono">
            {[
              'GPS stays on device',
              'Coordinates encoded locally',
              'Circuit garbled server-side',
              'Evaluated locally in your browser',
              'Results verified against Merkle root',
            ].map((step, i, arr) => (
              <span key={step} className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-md bg-veil-bg border border-veil-border text-veil-text/90">
                  {step}
                </span>
                {i < arr.length - 1 && <span className="text-veil-muted">→</span>}
              </span>
            ))}
          </div>
        </div>

        {/* Honest disclaimer — required, not optional */}
        <div className="mt-8 p-4 rounded-lg bg-yellow-900/10 border border-yellow-700/25 flex gap-3">
          <span className="text-yellow-400 text-base leading-none mt-0.5">⚠</span>
          <div className="text-xs text-yellow-200/80 leading-relaxed">
            <span className="font-semibold text-yellow-300">Research / final-year-project prototype.</span>{' '}
            The oblivious transfer (OT) layer used to select garbled-circuit wire labels is currently{' '}
            <span className="font-mono text-yellow-300">simulated</span>: the server sends both label options and the
            client selects locally, so your query bits and coordinates are never transmitted, but the choice itself
            isn't cryptographically hidden the way a production Naor-Pinkas/ECDH OT implementation would hide it.
            This limitation is documented, not hidden — see the Security dashboard inside the app for details.
          </div>
        </div>

        <div className="text-center text-[11px] font-mono text-veil-muted/60 mt-12">
          VEIL · Bengaluru, India · Real OpenStreetMap data via the Overpass API
        </div>
      </div>
    </div>
  )
}
