import { Crosshair, Server, Ear, Radio, Rocket, Settings, Search, LogOut, Terminal } from 'lucide-react'
import { Logo, Avatar, Segmented } from './ui.jsx'
import { WORKSPACES } from '../constants.js'

export const PAGES = [
  { id: 'overview', label: 'Sessions', icon: Crosshair },
  { id: 'listeners', label: 'Listeners', icon: Ear, exec: true },
  { id: 'fleet', label: 'MIPS C2', icon: Radio, exec: true },
  { id: 'deployments', label: 'Payloads', icon: Rocket },
  { id: 'settings', label: 'Config', icon: Settings },
]

const visiblePages = (execEnabled) => PAGES.filter((p) => !p.exec || execEnabled)

export function TopBar({ session, workspace, onWorkspace, query, onQuery, onLogout }) {
  return (
    <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-line">
      <div className="max-w-[1400px] mx-auto px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Logo size="sm" />

        <div className="hidden sm:block border-l border-line h-5 mx-1" />

        <Segmented options={WORKSPACES.map((w) => ({ value: w.id, label: w.label }))} value={workspace} onChange={onWorkspace} />

        <div className="relative order-last sm:order-none basis-full sm:basis-auto sm:flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted" />
          <input
            className="w-full rounded border border-line bg-page outline-none pl-9 pr-3 py-1.5 text-[13px] font-mono text-ink placeholder:text-muted focus:border-accent"
            placeholder="search agents..."
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:block font-mono text-[12px] text-muted">
            <span className="text-accent">@</span>{session.name}
          </span>
          <Avatar name={session.name} />
          <button onClick={onLogout} title="Log out" className="p-1.5 rounded text-muted hover:bg-raised hover:text-ink cursor-pointer">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </header>
  )
}

export function Sidebar({ page, onPage, nodes, subnet, live, demo, execEnabled }) {
  const count = (s) => nodes.filter((n) => n.status === s).length
  const total = nodes.length
  const callbacks = count('healthy') + count('scanning')

  return (
    <aside className="hidden md:block w-48 shrink-0">
      <div className="sticky top-16 space-y-3">
        <nav className="space-y-0.5">
          {visiblePages(execEnabled).map(({ id, label, icon: Icon }) => {
            const active = id === page
            return (
              <button
                key={id}
                onClick={() => onPage(id)}
                className={`w-full flex items-center gap-3 rounded px-3 py-2 text-[13px] font-mono cursor-pointer transition-colors ${
                  active ? 'bg-raised text-accent font-semibold border border-line' : 'text-muted hover:text-ink hover:bg-raised border border-transparent'
                }`}
              >
                <Icon className="size-4" strokeWidth={active ? 2.5 : 1.75} />
                {label}
              </button>
            )
          })}
        </nav>

        <button onClick={() => onPage('deployments')} className="btn btn-primary w-full py-2 flex items-center justify-center gap-2 text-[12px]">
          <Terminal className="size-3.5" /> DEPLOY
        </button>

        <div className="card p-3 text-[12px] font-mono space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-bright font-semibold">agents</span>
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase ${
                live ? 'text-ok bg-ok/10 border border-ok/20' : 'text-muted bg-raised border border-line'
              }`}
            >
              <span className={`size-1.5 rounded-full bg-current ${live ? 'animate-pulse' : ''}`} />
              {live ? 'LIVE' : demo ? 'DEMO' : 'IDLE'}
            </span>
          </div>
          <div className="flex justify-between text-muted">
            auth <span className="text-ink">{live ? 'mTLS' : '—'}</span>
          </div>
          <div className="border-t border-line my-1" />
          <div className="flex justify-between text-muted">
            callbacks <span className="text-ok font-semibold">{callbacks}</span>
          </div>
          <div className="flex justify-between text-muted">
            dead <span className="text-bad font-semibold">{count('offline')}</span>
          </div>
          <div className="flex justify-between text-muted">
            total <span className="text-bright font-semibold">{total}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

export function BottomNav({ page, onPage, execEnabled }) {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-surface border-t border-line flex justify-around py-2">
      {visiblePages(execEnabled).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onPage(id)}
          aria-label={label}
          className={`p-2 rounded cursor-pointer ${id === page ? 'text-accent' : 'text-muted'}`}
        >
          <Icon className="size-5" strokeWidth={id === page ? 2.5 : 1.75} />
        </button>
      ))}
    </nav>
  )
}
