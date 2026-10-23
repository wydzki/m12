import { KeyRound, Rocket, Radar, AlertTriangle, XCircle, WifiOff } from 'lucide-react'
import { shortAgo } from './ui.jsx'

const KIND = {
  auth:    { icon: KeyRound,      label: 'Auth',    cls: 'bg-ok/10 text-ok' },
  deploy:  { icon: Rocket,        label: 'Deploy',  cls: 'bg-accent/10 text-accent' },
  scan:    { icon: Radar,         label: 'Scan',    cls: 'bg-accent/10 text-accent' },
  warn:    { icon: AlertTriangle, label: 'Warning', cls: 'bg-amber-100 text-amber-600' },
  fail:    { icon: XCircle,       label: 'Failed',  cls: 'bg-bad/10 text-bad' },
  offline: { icon: WifiOff,       label: 'Offline', cls: 'bg-line text-muted' },
}

export default function ActivityFeed({ events, limit }) {
  const list = limit ? events.slice(0, limit) : events

  return (
    <section className="card overflow-hidden self-start">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="font-bold text-[17px]">Event Log</h2>
        <span className="flex items-center gap-1.5 text-[13px] text-muted">
          <span className="size-2 rounded-full bg-ok animate-pulse" /> Live
        </span>
      </div>
      {list.length === 0 && <p className="px-4 py-6 text-center text-muted text-[14px]">No events yet.</p>}
      <ol>
        {list.map((e) => {
          const { icon: Icon, label, cls } = KIND[e.kind]
          const isBad = e.kind === 'fail' || e.kind === 'warn' || e.kind === 'offline'
          return (
            <li key={e.no} className="flex gap-3 px-4 py-3 border-t border-line">
              <div className={`size-8 shrink-0 rounded-lg grid place-items-center ${cls}`}>
                <Icon className="size-4" />
              </div>
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`font-semibold text-[12px] uppercase tracking-wide ${isBad ? (e.kind === 'offline' ? 'text-muted' : 'text-bad') : 'text-muted'}`}>
                    {label}
                  </span>
                  <span className="text-muted/60 ml-auto shrink-0 text-[12px]">{shortAgo(e.at)}</span>
                </div>
                <p className={`mt-0.5 leading-snug break-words ${isBad && e.kind !== 'offline' ? 'text-bad' : ''}`}>
                  {e.text}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
