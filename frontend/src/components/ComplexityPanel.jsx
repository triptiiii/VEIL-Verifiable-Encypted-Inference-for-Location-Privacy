import { useState, useEffect } from 'react'
import { api } from '../services/api'

function ComplexityRow({ label, plain, secure, highlight = false }) {
  return (
    <tr className={`border-b border-veil-border/50 ${highlight ? 'bg-veil-accent/5' : ''}`}>
      <td className="py-2 pr-3 text-xs text-veil-muted font-mono">{label}</td>
      <td className="py-2 pr-3 text-xs text-yellow-400 font-mono">{plain}</td>
      <td className="py-2 text-xs text-veil-teal font-mono">{secure}</td>
    </tr>
  )
}

export default function ComplexityPanel({ datasetMeta, k }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!datasetMeta) return
    setLoading(true)
    api.complexity(k)
      .then(d => setReport(d.report))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [datasetMeta, k])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="flex gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-veil-accent load-dot" />
          <div className="w-1.5 h-1.5 rounded-full bg-veil-accent load-dot" />
          <div className="w-1.5 h-1.5 rounded-full bg-veil-accent load-dot" />
        </div>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="p-4 text-xs text-veil-muted font-mono">
        Load a dataset to see complexity analysis
      </div>
    )
  }

  const { input, plainKNN, secureKNN, comparison } = report

  return (
    <div className="p-4 space-y-5 text-sm animate-fadeIn">
      {/* Input params */}
      <div>
        <div className="veil-label mb-2">Parameters</div>
        <div className="flex gap-4 font-mono text-xs">
          <div><span className="text-veil-muted">n = </span><span className="text-veil-accent">{input.n}</span><span className="text-veil-muted"> POIs</span></div>
          <div><span className="text-veil-muted">k = </span><span className="text-veil-accent">{input.k}</span></div>
          <div><span className="text-veil-muted">b = </span><span className="text-veil-accent">{input.b}</span><span className="text-veil-muted"> bits</span></div>
        </div>
      </div>

      {/* Comparison table */}
      <div>
        <div className="veil-label mb-2">Comparison</div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-veil-border">
              <th className="text-left py-1.5 text-xs text-veil-muted font-mono pr-3">Metric</th>
              <th className="text-left py-1.5 text-xs text-yellow-400 font-mono pr-3">Plain</th>
              <th className="text-left py-1.5 text-xs text-veil-teal font-mono">Secure</th>
            </tr>
          </thead>
          <tbody>
            <ComplexityRow
              label="Time"
              plain={plainKNN.timeComplexity}
              secure={`O(n·b²) per POI`}
            />
            <ComplexityRow
              label="Space"
              plain={plainKNN.spaceComplexity}
              secure={`O(n·b²) gates`}
            />
            <ComplexityRow
              label="AND gates"
              plain="0"
              secure={secureKNN.totalAndGates?.toLocaleString()}
            />
            <ComplexityRow
              label="AES calls"
              plain="0"
              secure={secureKNN.totalAESCalls?.toLocaleString()}
            />
            <ComplexityRow
              label="Circuit KB"
              plain="—"
              secure={`${secureKNN.circuitTransferKB} KB`}
            />
            <ComplexityRow
              label="OT KB"
              plain="—"
              secure={`${secureKNN.otTransferKB} KB`}
            />
            <ComplexityRow
              label="Privacy"
              plain="None"
              secure="Semi-honest"
              highlight
            />
          </tbody>
        </table>
      </div>

      {/* Circuit detail */}
      <div>
        <div className="veil-label mb-2">Circuit Anatomy (per POI)</div>
        <div className="space-y-2">
          {[
            { label: 'SUB (dx, dy)', gates: 2 * (input.b + 1), color: '#7c3aed', note: 'Ripple-carry subtractor' },
            { label: 'SQR (dx², dy²)', gates: 2 * input.b * input.b, color: '#f97316', note: 'Schoolbook squarer' },
            { label: 'ADD (dist²)', gates: 2 * input.b + 1, color: '#00c6ff', note: 'Ripple-carry adder' },
            { label: 'CMP (compare)', gates: 2 * input.b + 1, color: '#22c55e', note: 'Bitwise comparator' },
          ].map(row => {
            const pct = (row.gates / secureKNN.gatesPerPOI * 100).toFixed(0)
            return (
              <div key={row.label} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-mono" style={{ color: row.color }}>{row.label}</span>
                  <span className="text-veil-muted">{row.gates.toLocaleString()} gates ({pct}%)</span>
                </div>
                <div className="h-1.5 bg-veil-border rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: row.color }} />
                </div>
                <div className="text-[10px] text-veil-muted font-mono">{row.note}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Gate types */}
      <div>
        <div className="veil-label mb-2">Gate Encoding Costs</div>
        <div className="space-y-1 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-veil-teal">XOR (Free-XOR)</span>
            <span className="text-veil-muted">0 AES calls ✓</span>
          </div>
          <div className="flex justify-between">
            <span className="text-veil-coral">AND (half-gates)</span>
            <span className="text-veil-muted">2 AES calls / gate</span>
          </div>
          <div className="flex justify-between">
            <span className="text-veil-accent">OT per bit</span>
            <span className="text-veil-muted">1 base OT (IKNP ext.)</span>
          </div>
          <div className="flex justify-between pt-1 border-t border-veil-border">
            <span className="text-white">Est. garble time</span>
            <span className="text-veil-accent">{secureKNN.garbleTimeMs}</span>
          </div>
        </div>
      </div>

      {/* Trade-off summary */}
      <div className="p-3 rounded-lg bg-veil-card border border-veil-border text-xs space-y-1">
        <div className="font-mono text-veil-accent mb-1">Privacy ↔ Performance Trade-off</div>
        <div className="text-veil-muted leading-relaxed">{comparison.speedRatio}</div>
        <div className="text-veil-muted leading-relaxed">{comparison.privacyTradeoff}</div>
        <div className="text-veil-green mt-1">{comparison.recommended}</div>
      </div>
    </div>
  )
}
