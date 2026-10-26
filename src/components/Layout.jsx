import { Search, LogOut } from 'lucide-react'
import { Logo } from './ui.jsx'

export const PAGES = [
  { id: 'overview', label: 'Dashboard' },
  { id: 'listeners', label: 'Listeners', exec: true },
  { id: 'fleet', label: 'MIPS C2', exec: true },
  { id: 'deployments', label: 'Payloads' },
  { id: 'settings', label: 'Config' },
]

const visiblePages = (execEnabled) => PAGES.filter((p) => !p.exec || execEnabled)

export function TopBar({ session, workspace, onWorkspace, query, onQuery, onLogout, page, onPage, execEnabled }) {
  return (
    <header className="sticky top-0 z-20 bg-surface border-b border-line">
      <div className="flex items-center gap-0 overflow-x-auto">
        <div className="flex items-center gap-2 px-3 py-1.5 border-r border-line shrink-0">
          <Logo size="sm" />
        </div>

        {visiblePages(execEnabled).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => onPage(id)}
            className={`shrink-0 px-3 py-1.5 text-[11px] font-mono font-semibold uppercase tracking-wider border-r border-line cursor-pointer ${
              id === page
                ? 'bg-raised text-accent'
                : 'text-muted hover:text-ink hover:bg-raised/50'
            }`}
          >
            {label}
          </button>
        ))}

        <div className="flex-1" />

        <div className="hidden sm:flex items-center gap-2 px-3 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted" />
            <input
              className="w-44 border border-line bg-page outline-none pl-7 pr-2 py-1 text-[11px] font-mono text-ink placeholder:text-muted focus:border-accent"
              placeholder="search..."
              value={query}
              onChange={(e) => onQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 border-l border-line shrink-0">
          <span className="hidden sm:block font-mono text-[10px] text-muted">
            <span className="text-accent">@</span>{session.name}
          </span>
          <button onClick={onLogout} title="Log out" className="p-1 text-muted hover:bg-raised hover:text-ink cursor-pointer">
            <LogOut className="size-3" />
          </button>
        </div>
      </div>
    </header>
  )
}

export function StatusPanel({ nodes, live, demo, execEnabled, buildEnabled }) {
  const count = (s) => nodes.filter((n) => n.status === s).length
  const total = nodes.length
  const callbacks = count('healthy') + count('scanning')

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="card overflow-hidden">
        <div className="px-3 py-1.5 border-b border-line bg-raised/30">
          <h3 className="font-mono font-semibold text-[10px] text-accent uppercase tracking-wider">Configuration</h3>
        </div>
        <div className="divide-y divide-line text-[11px] font-mono">
          <Row label="Status" value={live ? 'LIVE' : demo ? 'DEMO' : 'IDLE'} tone={live ? 'ok' : 'muted'} />
          <Row label="Auth method" value={live ? 'mTLS' : '—'} />
          <Row label="Exec enabled" value={execEnabled ? 'True' : 'False'} tone={execEnabled ? 'ok' : 'muted'} />
          <Row label="Build enabled" value={buildEnabled ? 'True' : 'False'} tone={buildEnabled ? 'ok' : 'muted'} />
          <Row label="Total clients" value={total} />
          <Row label="Authorized clients" value={total} />
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-3 py-1.5 border-b border-line bg-raised/30">
          <h3 className="font-mono font-semibold text-[10px] text-accent uppercase tracking-wider">Fleet Status</h3>
        </div>
        <div className="px-3 py-2 space-y-2">
          <ProgressRow label="Online" value={callbacks} max={total || 1} color="ok" />
          <ProgressRow label="Active" value={count('scanning')} max={total || 1} color="blue" />
          <ProgressRow label="Offline" value={count('offline')} max={total || 1} color="bad" />
          <div className="border-t border-line pt-2 space-y-1 text-[11px] font-mono">
            <div className="flex justify-between">
              <span className="text-muted">Callbacks</span>
              <span className="text-ok font-semibold">{callbacks}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Dead</span>
              <span className="text-bad font-semibold">{count('offline')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Total</span>
              <span className="text-bright font-semibold">{total}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, tone }) {
  const cls = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'muted' ? 'text-muted' : 'text-ink'
  return (
    <div className="flex items-center justify-between px-3 py-1">
      <span className="text-muted">{label}</span>
      <span className={`font-semibold ${cls}`}>{value}</span>
    </div>
  )
}

function ProgressRow({ label, value, max, color }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const bg = color === 'ok' ? 'bg-ok' : color === 'bad' ? 'bg-bad' : color === 'blue' ? 'bg-blue' : 'bg-accent'
  return (
    <div>
      <div className="flex justify-between text-[11px] font-mono mb-0.5">
        <span className="text-muted">{label}</span>
        <span className="text-ink">{pct}%</span>
      </div>
      <div className="h-1.5 bg-raised overflow-hidden border border-line">
        <div className={`h-full ${bg}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function BottomNav({ page, onPage, execEnabled }) {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-surface border-t border-line flex justify-around py-2">
      {visiblePages(execEnabled).map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onPage(id)}
          aria-label={label}
          className={`px-3 py-1.5 rounded text-[10px] font-mono font-semibold uppercase cursor-pointer ${id === page ? 'text-accent bg-raised' : 'text-muted'}`}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
