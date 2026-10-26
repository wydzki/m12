import { useState } from 'react'
import { Ear, Terminal, Wifi, WifiOff } from 'lucide-react'
import { ago, Segmented } from './ui.jsx'

const th = 'px-3 py-2.5 text-left text-[11px] font-mono font-semibold text-muted uppercase tracking-wider whitespace-nowrap'
const td = 'px-3 py-2.5 border-t border-line whitespace-nowrap'

export default function Listeners({ nodes, onTerminal }) {
  const [filter, setFilter] = useState('online')
  const online = nodes.filter((n) => n.status !== 'offline')
  const offline = nodes.filter((n) => n.status === 'offline')
  const rows = filter === 'online' ? online : filter === 'offline' ? offline : nodes

  const filters = [
    { value: 'online', label: `online (${online.length})` },
    { value: 'offline', label: `offline (${offline.length})` },
    { value: 'all', label: `all (${nodes.length})` },
  ]

  return (
    <div className="space-y-3 max-w-5xl">
      <section className="card p-4">
        <div className="flex items-center gap-3">
          <Ear className="size-4 text-accent" />
          <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider">Listeners</h2>
          <span className="font-mono text-[12px] text-muted">{online.length} active / {nodes.length} total</span>
        </div>
        <p className="text-muted text-[12px] font-mono mt-1">
          clients reporting over mTLS. select a client to open a remote shell.
        </p>
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
          <Segmented options={filters} value={filter} onChange={setFilter} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[13px] font-mono">
            <thead>
              <tr className="bg-raised/50">
                <th className={th}></th>
                <th className={th}>Client ID</th>
                <th className={th}>IP</th>
                <th className={th}>Hostname</th>
                <th className={th}>System</th>
                <th className={th}>Region</th>
                <th className={th}>Last Seen</th>
                <th className={th}>Uptime</th>
                {onTerminal && <th className={th}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => {
                const isOnline = n.status !== 'offline'
                return (
                  <tr key={n.id} className={`transition-colors ${isOnline ? 'hover:bg-raised/60' : 'opacity-50 hover:opacity-70'}`}>
                    <td className={`${td} w-8`}>
                      {isOnline
                        ? <Wifi className="size-3.5 text-ok" />
                        : <WifiOff className="size-3.5 text-muted" />
                      }
                    </td>
                    <td className={`${td} font-semibold ${isOnline ? 'text-bright' : 'text-muted'}`}>{n.id}</td>
                    <td className={`${td} ${isOnline ? 'text-accent' : 'text-muted'}`}>{n.ip}</td>
                    <td className={`${td} text-muted`}>{n.hostname ?? '—'}</td>
                    <td className={`${td} text-muted`}>{n.systemType ?? '—'}</td>
                    <td className={`${td} text-muted`}>{n.region}</td>
                    <td className={`${td} text-muted text-[12px]`}>{ago(n.lastSeen)}</td>
                    <td className={`${td} text-muted text-[12px]`}>
                      {n.metrics?.uptime != null ? formatUptime(n.metrics.uptime) : '—'}
                    </td>
                    {onTerminal && (
                      <td className={td}>
                        {isOnline && (
                          <button
                            onClick={() => onTerminal(n.id)}
                            className="btn btn-ghost py-1 px-2 text-[11px] font-mono flex items-center gap-1.5"
                          >
                            <Terminal className="size-3" /> shell
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={onTerminal ? 9 : 8} className={`${td} text-center py-8 text-muted`}>
                    no {filter} clients
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function formatUptime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}
