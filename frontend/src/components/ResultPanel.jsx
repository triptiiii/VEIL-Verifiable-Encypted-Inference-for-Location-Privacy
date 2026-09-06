const CATEGORY_META = {
  hospital:   { icon: '🏥', color: 'text-red-400',    accent: '#f87171' },
  restaurant: { icon: '🍽️', color: 'text-orange-400', accent: '#fb923c' },
  pharmacy:   { icon: '💊', color: 'text-green-400',  accent: '#4ade80' },
  cafe:       { icon: '☕', color: 'text-yellow-400', accent: '#facc15' },
  default:    { icon: '📍', color: 'text-slate-400',  accent: '#94a3b8' },
}

function formatDist(m) {
  if (m === undefined) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`
}

function TimingBar({ label, value, total, color = '#00c6ff' }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-veil-muted font-mono">{label}</span>
        <span className="font-mono" style={{ color }}>{parseFloat(value).toFixed(1)} ms</span>
      </div>
      <div className="h-1.5 bg-veil-border rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  )
}

function VerificationBadge({ valid }) {
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border ${
      valid
        ? 'bg-veil-green/10 border-green-700/40 text-veil-green'
        : 'bg-red-900/20 border-red-800/40 text-red-400'
    }`}>
      {valid ? '✓ Merkle Verified' : '✗ Proof Failed'}
    </div>
  )
}

export default function ResultPanel({ results, loading, error, meta, userLocation, mode }) {  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3">
        <div className="flex gap-2">
          <div className="w-2 h-2 rounded-full bg-veil-accent load-dot" />
          <div className="w-2 h-2 rounded-full bg-veil-accent load-dot" />
          <div className="w-2 h-2 rounded-full bg-veil-accent load-dot" />
        </div>
        <div className="text-xs font-mono text-veil-muted">
          {mode === 'secure' ? 'Evaluating garbled circuit…' : 'Computing kNN…'}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="p-3 rounded-lg bg-red-900/20 border border-red-800/30 text-xs text-red-400 font-mono">
          Error: {error}
        </div>
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2 text-veil-muted">
        <div className="text-3xl opacity-20">◎</div>
        <div className="text-xs font-mono">No results yet</div>
        <div className="text-xs text-center px-6">Get your location and run a query to see nearest POIs</div>
      </div>
    )
  }

  const timings = meta?.timings
  const totalMs = timings ? parseFloat(timings.totalMs || Object.values(timings).reduce((s, v) => s + parseFloat(v || 0), 0)) : 0

  // Per-result Merkle verification lookup (details[].poiId -> {valid, reason})
  const verificationByPoiId = new Map(
    (meta?.verificationResult?.details || []).map((d) => [d.poiId, d])
  )

  return (
    <div className="p-4 space-y-4 animate-fadeIn">
      {/* Mode + verification */}
      <div className="flex items-center justify-between">
        <div className={`text-xs font-mono px-2 py-1 rounded border ${
          mode === 'secure'
            ? 'text-veil-teal border-veil-teal/30 bg-veil-teal/10'
            : 'text-yellow-400 border-yellow-700/30 bg-yellow-900/20'
        }`}>
          {mode === 'secure' ? '🔒 Secure GC' : '⚠ Plaintext'}
        </div>
        {meta?.verificationResult && (
          <VerificationBadge valid={meta.verificationResult.valid} />
        )}
      </div>

      {/* Results list */}
      <div className="space-y-2">
        <div className="veil-label">k Nearest POIs</div>
        {results.map((poi, idx) => {
          const meta2 = CATEGORY_META[poi.category] || CATEGORY_META.default
          return (
            <div
              key={poi.id}
              className="p-3 rounded-lg border border-veil-border bg-veil-card hover:border-veil-muted/40 transition-colors animate-slideUp"
              style={{ animationDelay: `${idx * 60}ms` }}
            >
              <div className="flex items-start gap-2.5">
                {/* Rank badge */}
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
                  style={{ background: meta2.accent + '22', border: `1px solid ${meta2.accent}55`, color: meta2.accent }}
                >
                  {idx + 1}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-base">{meta2.icon}</span>
                    <span className="text-sm font-medium text-veil-text truncate">{poi.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className={`capitalize ${meta2.color}`}>{poi.category}</span>
                    <span className="text-veil-accent font-mono">⊙ {formatDist(poi.distMetres)}</span>
                  </div>
                  {poi.tags?.address && (
                    <div className="text-xs text-veil-muted mt-1 truncate">{poi.tags.address}</div>
                  )}
                  {poi.tags?.openingHours && (
                    <div className="text-xs text-veil-muted mt-0.5">🕐 {poi.tags.openingHours}</div>
                  )}
                  {poi.tags?.phone && (
                    <div className="text-xs text-veil-muted">📞 {poi.tags.phone}</div>
                  )}
                  {/* Per-result Merkle verification (spec: "Result N VERIFIED") */}
                  {verificationByPoiId.has(poi.id) && (
                    <div
                      className={`mt-1.5 inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                        verificationByPoiId.get(poi.id).valid
                          ? 'text-veil-green border-green-700/30 bg-veil-green/5'
                          : 'text-red-400 border-red-800/40 bg-red-900/10'
                      }`}
                    >
                      {verificationByPoiId.get(poi.id).valid
                        ? `✓ Result ${idx + 1} VERIFIED`
                        : `✗ Result ${idx + 1} VERIFICATION FAILED`}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Timing breakdown */}
      {timings && (
        <div className="space-y-3 pt-2 border-t border-veil-border">
          <div className="veil-label">Latency Breakdown</div>
          {mode === 'secure' ? (
            <>
              {timings.garbleMs && (
                <TimingBar label="Garble circuit" value={timings.garbleMs} total={totalMs} color="#7c3aed" />
              )}
              {timings.otMs && (
                <TimingBar label="OT protocol" value={timings.otMs} total={totalMs} color="#f97316" />
              )}
              {timings.evalMs && (
                <TimingBar label="Circuit eval" value={timings.evalMs} total={totalMs} color="#00c6ff" />
              )}
              {timings.merkleMs && (
                <TimingBar label="Merkle proof" value={timings.merkleMs} total={totalMs} color="#22c55e" />
              )}
              <div className="flex justify-between text-xs border-t border-veil-border pt-2">
                <span className="text-veil-muted font-mono">Total</span>
                <span className="font-mono text-white">{timings.totalMs || totalMs.toFixed(1)} ms</span>
              </div>
            </>
          ) : (
            <div className="flex justify-between text-xs">
              <span className="text-veil-muted font-mono">kNN compute</span>
              <span className="font-mono text-veil-accent">{meta?.latencyMs} ms</span>
            </div>
          )}
        </div>
      )}

      {/* Privacy statement */}
      {meta?.privacyStatement && (
        <div className="p-3 rounded-lg bg-veil-teal/5 border border-veil-teal/20">
          <div className="text-xs text-veil-teal font-mono mb-1">Privacy Log</div>
          <div className="text-xs text-veil-muted leading-relaxed">{meta.privacyStatement}</div>
        </div>
      )}

      {/* Merkle root */}
      {meta?.merkleRoot && (
        <div className="text-xs font-mono">
          <span className="text-veil-muted">Dataset root: </span>
          <span className="text-veil-purple">{meta.merkleRoot.slice(0, 20)}…</span>
        </div>
      )}
    </div>
  )
}
