import { useEffect, useState } from 'react'
import { StatusBadge, Pager, Segmented, ago } from './ui.jsx'

const th = 'px-4 py-3 text-left text-[13px] font-semibold text-muted whitespace-nowrap'
const td = 'px-4 py-3 border-t border-line whitespace-nowrap'

const FILTERS = ['all', 'healthy', 'scanning', 'offline'].map((f) => ({ value: f, label: f[0].toUpperCase() + f.slice(1) }))

export function NodesTable({ nodes, resetKey, pageSize = 5, showFilters = false, title = 'Active Nodes', onTerminal }) {
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('all')

  const rows = filter === 'all' ? nodes : nodes.filter((n) => n.status === filter)
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, pages - 1) // data refreshes can shrink the list
  const visible = rows.slice(current * pageSize, current * pageSize + pageSize)

  // back to page 1 on a new search or filter
  useEffect(() => setPage(0), [resetKey, filter])

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3">
        <h2 className="font-bold text-[17px]">{title}</h2>
        <span className="text-muted text-[14px]">{rows.length} nodes</span>
        {showFilters && (
          <div className="ml-auto">
            <Segmented options={FILTERS} value={filter} onChange={setFilter} />
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr>
              <th className={th}>Node ID</th>
              <th className={th}>Region</th>
              <th className={th}>Status</th>
              <th className={th}>Last Check-in</th>
              {onTerminal && <th className={th}></th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((n) => (
              <tr key={n.id} className="hover:bg-soft transition-colors">
                <td className={td}>
                  <div className="font-semibold font-mono text-[13px]">{n.id}</div>
                  <div className="text-accent text-[12px]">&gt;&gt;{n.ip}</div>
                </td>
                <td className={`${td} text-muted`}>{n.region}</td>
                <td className={td}>
                  <StatusBadge status={n.status} />
                </td>
                <td className={`${td} text-muted`}>{ago(n.lastSeen)}</td>
                {onTerminal && (
                  <td className={td}>
                    <button onClick={() => onTerminal(n.id)} className="pill pill-outline py-1 px-3 text-[13px]">
                      Terminal
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={onTerminal ? 5 : 4} className={`${td} text-center py-10 text-muted`}>
                  No nodes match. <span className="greentext">&gt;tfw empty subnet</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} />}
    </section>
  )
}

export function DeploymentsTable({ deployments }) {
  return (
    <section className="card overflow-hidden">
      <h2 className="font-bold text-[17px] px-4 pt-4 pb-3">Deployments</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr>
              <th className={th}>ID</th>
              <th className={th}>Payload</th>
              <th className={th}>Target</th>
              <th className={th}>Status</th>
              <th className={th}>By</th>
              <th className={th}>Duration</th>
              <th className={th}>When</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id} className="hover:bg-soft transition-colors">
                <td className={`${td} font-mono text-[13px] font-semibold`}>{d.id}</td>
                <td className={td}>
                  {d.payload} <span className="text-muted">@{d.version}</span>
                </td>
                <td className={`${td} font-mono text-[13px]`}>{d.target}</td>
                <td className={td}>
                  <StatusBadge status={d.status} />
                </td>
                <td className={`${td} font-semibold`}>{d.by}</td>
                <td className={`${td} text-muted`}>{d.duration}</td>
                <td className={`${td} text-muted`}>{ago(d.at)}</td>
              </tr>
            ))}
            {deployments.length === 0 && (
              <tr>
                <td colSpan={7} className={`${td} text-center py-10 text-muted`}>
                  No deployments yet. <span className="greentext">&gt;awaiting first payload push</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
