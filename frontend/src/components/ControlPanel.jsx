const CATEGORY_META = {
  hospital:   { icon: '🏥', color: 'text-red-400',    border: 'border-red-800/40',    bg: 'bg-red-900/20'    },
  restaurant: { icon: '🍽️', color: 'text-orange-400', border: 'border-orange-800/40', bg: 'bg-orange-900/20' },
  pharmacy:   { icon: '💊', color: 'text-green-400',  border: 'border-green-800/40',  bg: 'bg-green-900/20'  },
  cafe:       { icon: '☕', color: 'text-yellow-400', border: 'border-yellow-800/40', bg: 'bg-yellow-900/20' },
}

function Section({ title, children }) {
  return (
    <div className="border-b border-veil-border p-4">
      <div className="veil-label mb-3">{title}</div>
      {children}
    </div>
  )
}

export default function ControlPanel({
  mode, onModeChange,
  k, onKChange,
  categories, onCategoryToggle,
  locationStatus, locationError, userLocation,
  onRequestLocation, onRunQuery, queryLoading,
  datasetMeta, datasetLoading, onRefreshDataset,
}) {
  const noCategoriesSelected = categories.length === 0;
  return (
    <div className="flex flex-col h-full">

      {/* Privacy Mode */}
      <Section title="Privacy Mode">
        <div className="flex gap-2">
          {[
            { id: 'secure', label: 'Secure', sub: 'Garbled Circuit + OT' },
            { id: 'plain',  label: 'Plain',  sub: 'Baseline (no privacy)' },
          ].map(m => (
            <button
              key={m.id}
              onClick={() => onModeChange(m.id)}
              className={`flex-1 rounded-lg p-3 border text-left transition-all ${
                mode === m.id
                  ? m.id === 'secure'
                    ? 'border-veil-teal/50 bg-veil-teal/10 text-veil-teal'
                    : 'border-yellow-600/50 bg-yellow-900/20 text-yellow-400'
                  : 'border-veil-border text-veil-muted hover:border-veil-text/30'
              }`}
            >
              <div className="text-xs font-semibold">{m.label}</div>
              <div className="text-[10px] font-mono mt-0.5 opacity-70">{m.sub}</div>
            </button>
          ))}
        </div>
      </Section>

      {/* k Neighbours */}
      <Section title="k Neighbours">
        <div className="flex items-center gap-3">
          <input
            type="range" min="1" max="20" value={k}
            onChange={e => onKChange(Number(e.target.value))}
            className="flex-1 accent-veil-accent"
          />
          <span className="font-mono text-veil-accent text-lg w-6 text-right">{k}</span>
        </div>
        <div className="text-xs text-veil-muted mt-1 font-mono">
          Returns {k} nearest POI{k > 1 ? 's' : ''}
        </div>
      </Section>

      {/* Categories */}
      <Section title="POI Categories">
        <div className="space-y-2">
          {Object.entries(CATEGORY_META).map(([cat, meta]) => {
            const active = categories.includes(cat)
            return (
              <button
                key={cat}
                onClick={() => onCategoryToggle(cat)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm transition-all ${
                  active
                    ? `${meta.bg} ${meta.border} ${meta.color}`
                    : 'border-veil-border text-veil-muted hover:border-veil-text/30'
                }`}
              >
                <span className="text-base">{meta.icon}</span>
                <span className="capitalize flex-1 text-left">{cat}</span>
                <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${
                  active ? 'border-current bg-current/20' : 'border-veil-border'
                }`}>
                  {active ? '✓' : ''}
                </span>
              </button>
            )
          })}
        </div>
      </Section>

      {/* Location */}
      <Section title="Your Location">
        {locationStatus === 'idle' && (
          <button
            onClick={onRequestLocation}
            className="w-full veil-btn-primary flex items-center justify-center gap-2"
          >
            <span>⊙</span> Get GPS Location
          </button>
        )}
        {locationStatus === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-veil-muted">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-veil-accent load-dot" />
              <div className="w-1.5 h-1.5 rounded-full bg-veil-accent load-dot" />
              <div className="w-1.5 h-1.5 rounded-full bg-veil-accent load-dot" />
            </div>
            Acquiring GPS…
          </div>
        )}
        {locationStatus === 'ready' && userLocation && (
          <div className="space-y-2">
            {locationError && (
              <div className="text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-700/30 rounded p-2">
                {locationError}
              </div>
            )}
            <div className="font-mono text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-veil-muted">Lat</span>
                <span className="text-veil-accent">{userLocation.latitude.toFixed(6)}°</span>
              </div>
              <div className="flex justify-between">
                <span className="text-veil-muted">Lng</span>
                <span className="text-veil-accent">{userLocation.longitude.toFixed(6)}°</span>
              </div>
              {userLocation.accuracy && (
                <div className="flex justify-between">
                  <span className="text-veil-muted">Accuracy</span>
                  <span className="text-veil-green">±{Math.round(userLocation.accuracy)}m</span>
                </div>
              )}
            </div>
            <button
              onClick={onRequestLocation}
              className="text-xs text-veil-muted hover:text-veil-text font-mono"
            >
              ↺ Re-acquire
            </button>
          </div>
        )}
        {locationStatus === 'error' && (
          <div className="space-y-2">
            <div className="text-xs text-red-400">{locationError}</div>
            <button onClick={onRequestLocation} className="text-xs text-veil-muted hover:text-veil-text font-mono">
              Try again
            </button>
          </div>
        )}
      </Section>

      {/* Dataset */}
      <Section title="OSM Dataset">
        {datasetLoading ? (
          <div className="text-xs text-veil-muted flex items-center gap-2">
            <div className="flex gap-1">
              <div className="w-1 h-1 rounded-full bg-veil-muted load-dot" />
              <div className="w-1 h-1 rounded-full bg-veil-muted load-dot" />
              <div className="w-1 h-1 rounded-full bg-veil-muted load-dot" />
            </div>
            Fetching from OpenStreetMap…
          </div>
        ) : datasetMeta ? (
          <div className="space-y-2">
            <div className="font-mono text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-veil-muted">Total POIs</span>
                <span className="text-veil-accent">{datasetMeta.total}</span>
              </div>
              {Object.entries(datasetMeta.categories || {}).map(([cat, count]) => (
                <div key={cat} className="flex justify-between">
                  <span className="text-veil-muted capitalize">  {cat}</span>
                  <span className="text-veil-text">{count}</span>
                </div>
              ))}
              <div className="flex justify-between pt-1 border-t border-veil-border">
                <span className="text-veil-muted">Merkle Root</span>
                <span className="text-veil-purple text-[10px]">{datasetMeta.merkleRoot?.slice(0, 12)}…</span>
              </div>
            </div>
            <button
              onClick={onRefreshDataset}
              className="text-xs text-veil-muted hover:text-veil-text font-mono"
            >
              ↺ Refresh OSM data
            </button>
          </div>
        ) : (
          <div className="text-xs text-veil-muted">No dataset loaded</div>
        )}
      </Section>

      {/* Run Query */}
      <div className="p-4 mt-auto">
        {noCategoriesSelected && (
          <div className="text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-2 mb-2">
            Select at least one category to search.
          </div>
        )}
        <button
          onClick={onRunQuery}
          disabled={queryLoading || noCategoriesSelected}
          title={noCategoriesSelected ? 'Select at least one category first' : undefined}
          className={`w-full py-3 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 ${
            queryLoading || noCategoriesSelected
              ? 'bg-veil-border text-veil-muted cursor-not-allowed'
              : 'bg-gradient-to-r from-veil-accent to-veil-teal text-veil-bg hover:brightness-110 active:scale-95 shadow-lg shadow-veil-accent/20'
          }`}
        >
          {queryLoading ? (
            <>
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-veil-muted load-dot" />
                <div className="w-1.5 h-1.5 rounded-full bg-veil-muted load-dot" />
                <div className="w-1.5 h-1.5 rounded-full bg-veil-muted load-dot" />
              </div>
              Computing…
            </>
          ) : (
            <>
              ◈ Run {mode === 'secure' ? 'Secure' : 'Plain'} kNN
            </>
          )}
        </button>
        <div className="text-xs text-center text-veil-muted mt-2 font-mono">
          {mode === 'secure' ? 'Location stays private via GC+OT' : 'Location sent in plaintext'}
        </div>
      </div>
    </div>
  )
}
