export default function Header({ serverStatus, mode, view, onViewChange, onGoHome }) {
  return (
    <header className="h-14 flex items-center justify-between px-5 border-b border-veil-border bg-veil-card/80 backdrop-blur-sm flex-shrink-0 z-50">
      {/* Brand */}
      <button
        onClick={onGoHome}
        className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
        title="Back to overview"
      >
        <div className="relative">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-veil-accent to-veil-purple flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1L14 4.5V11.5L8 15L2 11.5V4.5L8 1Z" stroke="white" strokeWidth="1.2" fill="none"/>
              <circle cx="8" cy="8" r="2" fill="white" />
            </svg>
          </div>
          <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-veil-bg ${
            serverStatus === 'ok' ? 'bg-veil-green' : serverStatus === 'error' ? 'bg-red-500' : 'bg-yellow-500'
          }`} />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-wider text-white">VEIL</div>
          <div className="text-[10px] font-mono text-veil-muted -mt-0.5">Privacy-Preserving kNN</div>
        </div>
      </button>

      {/* Mode badge */}
      <div className={`px-3 py-1 rounded-full text-xs font-mono flex items-center gap-2 ${
        mode === 'secure'
          ? 'bg-veil-teal/10 border border-veil-teal/30 text-veil-teal'
          : 'bg-yellow-900/20 border border-yellow-700/30 text-yellow-400'
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${mode === 'secure' ? 'bg-veil-teal glow-pulse' : 'bg-yellow-400'}`} />
        {mode === 'secure' ? 'Garbled Circuit Active' : 'Plaintext Mode'}
      </div>

      {/* View switcher */}
      <div className="flex items-center gap-1 bg-veil-bg border border-veil-border rounded-lg p-0.5">
        {[
          { id: 'map', label: 'Map', icon: '◎' },
          { id: '3d', label: '3D', icon: '◈' },
        ].map(v => (
          <button
            key={v.id}
            onClick={() => onViewChange(v.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-mono transition-all ${
              view === v.id
                ? 'bg-veil-card text-veil-accent border border-veil-border'
                : 'text-veil-muted hover:text-veil-text'
            }`}
          >
            {v.icon} {v.label}
          </button>
        ))}
      </div>
    </header>
  )
}
