import { Crosshair, Radio, Terminal, Skull } from 'lucide-react'

const ICONS = { sessions: Crosshair, shells: Terminal, queued: Radio, dead: Skull }
const TONES = { good: 'text-accent', bad: 'text-bad', warn: 'text-warn', dim: 'text-muted' }

export function MetricCard({ metric }) {
  const Icon = ICONS[metric.key]
  const tone = TONES[metric.tone] || 'text-accent'
  return (
    <div className="card p-3 flex flex-col min-w-0 stat-glow">
      <div className="flex items-center gap-2 text-[11px] text-muted font-mono uppercase tracking-wider">
        {Icon && <Icon className="size-3.5" />}
        <span className="truncate">{metric.label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-[32px] font-mono font-bold leading-none tracking-tight text-bright`}>{metric.value}</span>
        <span className="text-[12px] text-muted font-mono">{metric.unit}</span>
      </div>
      <p className={`text-[11px] font-mono mt-1 ${tone}`}>{metric.note}</p>
    </div>
  )
}
