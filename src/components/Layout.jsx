import { LayoutDashboard, Server, Rocket, Radio, Settings, Search, LogOut, Plus } from 'lucide-react'
import { Logo, Avatar, Segmented } from './ui.jsx'
import { WORKSPACES } from '../constants.js'

export const PAGES = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'nodes', label: 'Nodes', icon: Server },
  { id: 'deployments', label: 'Deployments', icon: Rocket },
  { id: 'fleet', label: 'Broadcast', icon: Radio, exec: true },
  { id: 'settings', label: 'Settings', icon: Settings },
]

// Pages shown given the enabled features (Broadcast only when exec is on).
const visiblePages = (execEnabled) => PAGES.filter((p) => !p.exec || execEnabled)

export function TopBar({ session, workspace, onWorkspace, query, onQuery, onLogout }) {
  return (
    <header className="sticky top-0 z-20 bg-white/85 backdrop-blur border-b border-line">
      <div className="max-w-[1400px] mx-auto px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Logo size="sm" />

        <Segmented options={WORKSPACES.map((w) => ({ value: w.id, label: w.label }))} value={workspace} onChange={onWorkspace} />

        <div className="relative order-last sm:order-none basis-full sm:basis-auto sm:flex-1 sm:max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted" />
          <input
            className="w-full rounded-full bg-soft border border-transparent focus:border-accent focus:bg-white outline-none pl-10 pr-4 py-2 text-[14px]"
            placeholder="Search nodes, IPs, regions"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:block text-right leading-tight">
            <div className="font-bold text-[14px]">{session.name}</div>
            <div className="text-muted text-[13px]">@{session.name}</div>
          </div>
          <Avatar name={session.name} />
          <button onClick={onLogout} title="Log out" className="p-2 rounded-full text-muted hover:bg-soft hover:text-ink cursor-pointer">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </header>
  )
}

export function Sidebar({ page, onPage, nodes, subnet, live, demo, execEnabled }) {
  const count = (s) => nodes.filter((n) => n.status === s).length

  return (
    <aside className="hidden md:block w-56 shrink-0">
      <div className="sticky top-20 space-y-4">
        <nav className="space-y-1">
          {visiblePages(execEnabled).map(({ id, label, icon: Icon }) => {
            const active = id === page
            return (
              <button
                key={id}
                onClick={() => onPage(id)}
                className={`w-full flex items-center gap-4 rounded-full px-4 py-2.5 text-[17px] cursor-pointer hover:bg-soft ${
                  active ? 'font-bold' : ''
                }`}
              >
                <Icon className="size-5" strokeWidth={active ? 2.5 : 2} />
                {label}
              </button>
            )
          })}
        </nav>

        <button onClick={() => onPage('deployments')} className="pill pill-accent w-full py-3 flex items-center justify-center gap-2">
          <Plus className="size-4" /> Deploy
        </button>

        <div className="card p-4 text-[14px] space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-bold">Fleet</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                live ? 'text-ok bg-ok/10' : 'text-muted bg-line'
              }`}
              title={
                live
                  ? 'Receiving telemetry from mTLS-authenticated nodes'
                  : demo
                    ? 'No nodes connected — showing sample data'
                    : 'No nodes connected yet'
              }
            >
              <span className={`size-1.5 rounded-full bg-current ${live ? 'animate-pulse' : ''}`} />
              {live ? 'LIVE' : demo ? 'DEMO' : 'NO NODES'}
            </span>
          </div>
          <div className="flex justify-between text-muted">
            {live ? 'Source' : 'Subnet'}{' '}
            <span className="font-mono text-ink text-[13px]">{live ? 'mTLS ingest' : subnet ?? '—'}</span>
          </div>
          <div className="flex justify-between text-muted">
            Healthy <span className="font-bold text-ok">{count('healthy')}</span>
          </div>
          <div className="flex justify-between text-muted">
            Scanning <span className="font-bold text-accent">{count('scanning')}</span>
          </div>
          <div className="flex justify-between text-muted">
            Offline <span className="font-bold text-ink">{count('offline')}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

// Twitter-style bottom tab bar on phones
export function BottomNav({ page, onPage, execEnabled }) {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-white border-t border-line flex justify-around py-2">
      {visiblePages(execEnabled).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onPage(id)}
          aria-label={label}
          className={`p-2 rounded-full cursor-pointer ${id === page ? 'text-ink' : 'text-muted'}`}
        >
          <Icon className="size-6" strokeWidth={id === page ? 2.5 : 1.75} />
        </button>
      ))}
    </nav>
  )
}
