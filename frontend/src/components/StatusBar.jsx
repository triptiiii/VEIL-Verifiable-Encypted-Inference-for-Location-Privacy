function Dot({ color }) {
  return <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5" style={{ background: color }} />
}

export default function StatusBar({ serverStatus, datasetMeta, userLocation, results, queryLoading }) {
  const now = new Date()

  return (
    <div className="h-7 flex items-center px-4 gap-6 border-t border-veil-border bg-veil-card/60 text-[10px] font-mono text-veil-muted flex-shrink-0">
      {/* Server */}
      <span>
        <Dot color={serverStatus === 'ok' ? '#22c55e' : serverStatus === 'error' ? '#f87171' : '#facc15'} />
        {serverStatus === 'ok' ? 'Server online' : serverStatus === 'error' ? 'Server offline' : 'Connecting…'}
      </span>

      {/* Dataset */}
      {datasetMeta && (
        <span>
          <Dot color="#00c6ff" />
          {datasetMeta.total} POIs · Bengaluru
        </span>
      )}

      {/* Location */}
      {userLocation && (
        <span>
          <Dot color="#7c3aed" />
          {userLocation.latitude.toFixed(4)}°N {userLocation.longitude.toFixed(4)}°E
          {userLocation.simulated ? ' (demo)' : ''}
        </span>
      )}

      {/* Results */}
      {results.length > 0 && (
        <span>
          <Dot color="#00e5c0" />
          {results.length} result{results.length !== 1 ? 's' : ''} · {results[0]?.privacyMode === 'secure' ? 'Secure GC' : 'Plain'}
        </span>
      )}

      {/* Query state */}
      {queryLoading && (
        <span className="text-veil-accent">
          <Dot color="#00c6ff" />
          Computing…
        </span>
      )}

      {/* Time right-aligned */}
      <span className="ml-auto">
        {now.toLocaleTimeString()} · VEIL v1.0.0
      </span>
    </div>
  )
}
