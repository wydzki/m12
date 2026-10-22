import { useState } from 'react'
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Activity, Timer, PackageCheck, AlertTriangle } from 'lucide-react'
import { Segmented } from './ui.jsx'

const ICONS = { instances: Activity, latency: Timer, deploys: PackageCheck, errors: AlertTriangle }

const BLUE = '#1d9bf0'
const GREEN = '#00ba7c'
const RED = '#f4212e'
const MUTED = '#536471'

export function MetricCard({ metric }) {
  const Icon = ICONS[metric.key]
  const bad = metric.tone === 'bad'
  return (
    <div className="card p-4 flex flex-col min-w-0">
      <div className="flex items-center gap-2 text-[14px] text-muted">
        <Icon className="size-4" />
        <span className="truncate">{metric.label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[30px] font-bold leading-none tracking-tight">{metric.value}</span>
        <span className="text-[14px] text-muted">{metric.unit}</span>
      </div>
      <p className={`text-[13px] mt-1 ${bad ? 'text-bad' : 'greentext'}`}>{metric.note}</p>
      <div className="h-10 mt-2 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={metric.spark}>
            <Line type="monotone" dataKey="v" stroke={bad ? RED : BLUE} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="card px-3 py-2 text-[13px] shadow-lg">
      <div className="font-bold mb-0.5">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: p.stroke }} />
          <span className="text-muted capitalize">{p.dataKey}</span>
          <span className="ml-auto font-semibold">{p.value} Mbps</span>
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
        <h2 className="font-bold text-[17px]">Network Traffic</h2>
        <div className="flex gap-3 text-[13px] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: BLUE }} /> Inbound
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: GREEN }} /> Outbound
          </span>
        </div>
        <div className="ml-auto">
          <Segmented options={Object.keys(traffic).map((r) => ({ value: r, label: r }))} value={range} onChange={setRange} />
        </div>
      </div>

      <div className="h-56 sm:h-64 mt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="fillIn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={BLUE} stopOpacity={0.2} />
                <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="fillOut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GREEN} stopOpacity={0.2} />
                <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#eff3f4" vertical={false} />
            <XAxis dataKey="t" tick={{ fill: MUTED, fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={{ fill: MUTED, fontSize: 12 }} tickLine={false} axisLine={false} unit="M" width={48} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#cfd9de' }} />
            <Area type="monotone" dataKey="inbound" stroke={BLUE} strokeWidth={2} fill="url(#fillIn)" />
            <Area type="monotone" dataKey="outbound" stroke={GREEN} strokeWidth={2} fill="url(#fillOut)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
