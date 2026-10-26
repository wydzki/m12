import { Crosshair, Radio, Terminal, Skull } from 'lucide-react'

const ICONS = { sessions: Crosshair, shells: Terminal, queued: Radio, dead: Skull }
const TONES = { good: 'text-ok', bad: 'text-bad', warn: 'text-warn', dim: 'text-muted' }

export function MetricCard({ metric }) {
  const Icon = ICONS[metric.key]
  const tone = TONES[metric.tone] || 'text-accent'
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-2 border-b border-line bg-raised/30">
        <span className="text-[11px] text-muted font-mono font-semibold uppercase tracking-wider">{metric.label}</span>
      </div>
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[28px] font-mono font-bold leading-none tracking-tight text-bright">{metric.value}</span>
            <span className="text-[12px] text-muted font-mono">{metric.unit}</span>
          </div>
          <p className={`text-[11px] font-mono mt-1.5 ${tone}`}>{metric.note}</p>
        </div>
        {Icon && (
          <div className="shrink-0 size-10 rounded bg-raised border border-line grid place-items-center">
            <Icon className={`size-5 ${tone}`} />
          </div>
        )}
      </div>
    </div>
  )
}
