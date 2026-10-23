import { useState } from 'react'
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Activity, Timer, PackageCheck, AlertTriangle } from 'lucide-react'
import { Segmented } from './ui.jsx'

const ICONS = { instances: Activity, latency: Timer, deploys: PackageCheck, errors: AlertTriangle }

const GREEN = '#39c583'
const BLUE = '#4da6e8'
const RED = '#e5534b'
const MUTED = '#6b7a8d'
const GRID = '#252b38'

export function MetricCard({ metric }) {
  const Icon = ICONS[metric.key]
  const bad = metric.tone === 'bad'
  return (
    <div className="card p-3 flex flex-col min-w-0 stat-glow">
      <div className="flex items-center gap-2 text-[11px] text-muted font-mono uppercase tracking-wider">
        <Icon className="size-3.5" />
        <span className="truncate">{metric.label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-[28px] font-mono font-bold leading-none tracking-tight ${bad ? 'text-bad' : 'text-bright'}`}>{metric.value}</span>
        <span className="text-[12px] text-muted font-mono">{metric.unit}</span>
      </div>
      <p className={`text-[11px] font-mono mt-1 ${bad ? 'text-bad' : 'text-accent'}`}>{metric.note}</p>
      <div className="h-8 mt-2 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={metric.spark}>
            <Line type="monotone" dataKey="v" stroke={bad ? RED : GREEN} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="card px-3 py-2 text-[12px] font-mono shadow-lg border border-line">
      <div className="font-semibold text-bright mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: p.stroke }} />
          <span className="text-muted">{p.dataKey}</span>
          <span className="ml-auto text-ink">{p.value}</span>
        </div>
      ))}
    </div>
  )
}

export function TrafficChart({ traffic }) {
  const [range, setRange] = useState('24h')
  const data = traffic[range]

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider">Traffic</h2>
        <div className="flex gap-3 text-[11px] font-mono text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: BLUE }} /> in
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: GREEN }} /> out
          </span>
        </div>
        <div className="ml-auto">
          <Segmented options={Object.keys(traffic).map((r) => ({ value: r, label: r }))} value={range} onChange={setRange} />
        </div>
      </div>

      <div className="h-48 sm:h-56 mt-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="fillIn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={BLUE} stopOpacity={0.15} />
                <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="fillOut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GREEN} stopOpacity={0.15} />
                <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="t" tick={{ fill: MUTED, fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={{ fill: MUTED, fontSize: 11, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: GRID }} />
            <Area type="monotone" dataKey="inbound" stroke={BLUE} strokeWidth={1.5} fill="url(#fillIn)" />
            <Area type="monotone" dataKey="outbound" stroke={GREEN} strokeWidth={1.5} fill="url(#fillOut)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
