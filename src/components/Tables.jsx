import { useEffect, useMemo, useState } from 'react'
import { StatusBadge, Pager, Segmented, ago } from './ui.jsx'

const th = 'px-3 py-2.5 text-left text-[11px] font-mono font-semibold text-muted uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-ink transition-colors'
const td = 'px-3 py-2.5 border-t border-line whitespace-nowrap'

const FILTERS = ['all', 'healthy', 'scanning', 'offline'].map((f) => ({ value: f, label: f }))

const COLUMNS = [
  { key: 'id', label: 'ID', sortKey: (n) => n.id },
  { key: 'connection', label: 'Connection', sortKey: (n) => n.connection ?? '' },
  { key: 'externalIp', label: 'External IP', sortKey: (n) => n.externalIp ?? '' },
  { key: 'region', label: 'Region', sortKey: (n) => n.region ?? '' },
  { key: 'ip', label: 'Intranet IP', sortKey: (n) => n.ip },
  { key: 'user', label: 'User', sortKey: (n) => n.user ?? '' },
  { key: 'hostname', label: 'Host Name', sortKey: (n) => n.hostname ?? '' },
  { key: 'systemType', label: 'System Type', sortKey: (n) => n.systemType ?? '' },
  { key: 'processName', label: 'Process', sortKey: (n) => n.processName ?? '' },
  { key: 'status', label: 'Status', sortKey: (n) => n.status },
  { key: 'heartbeats', label: 'Heartbeat', sortKey: (n) => n.heartbeats ?? 0 },
]

function SortArrow({ active, dir }) {
  return (
    <span className={`inline-flex flex-col ml-1 leading-none ${active ? 'text-accent' : 'text-muted/40'}`}>
      <span className={`text-[8px] ${active && dir === 'asc' ? 'text-accent' : ''}`}>&#9650;</span>
      <span className={`text-[8px] -mt-0.5 ${active && dir === 'desc' ? 'text-accent' : ''}`}>&#9660;</span>
    </span>
  )
}

function OpMenu({ node, onTerminal }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="px-2 py-1 text-muted hover:text-ink text-[16px] leading-none rounded hover:bg-raised transition-colors"
      >
        &middot;&middot;&middot;
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-surface border border-line rounded shadow-lg py-1 min-w-[120px]">
            {onTerminal && node.status !== 'offline' && (
              <button
                onClick={() => { onTerminal(node.id); setOpen(false) }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-mono text-ink hover:bg-raised transition-colors"
              >
                shell
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="w-full text-left px-3 py-1.5 text-[12px] font-mono text-muted hover:bg-raised hover:text-ink transition-colors"
            >
              details
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function NodesTable({ nodes, resetKey, pageSize = 12, showFilters = false, title = 'Clients', onTerminal }) {
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('all')
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  const rows = filter === 'all' ? nodes : nodes.filter((n) => n.status === filter)

  const sorted = useMemo(() => {
    if (!sortCol) return rows
    const col = COLUMNS.find((c) => c.key === sortCol)
    if (!col) return rows
    const arr = [...rows]
    arr.sort((a, b) => {
      const va = col.sortKey(a)
      const vb = col.sortKey(b)
      if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
    return arr
  }, [rows, sortCol, sortDir])

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const current = Math.min(page, pages - 1)
  const visible = sorted.slice(current * pageSize, current * pageSize + pageSize)

  useEffect(() => setPage(0), [resetKey, filter])

  function toggleSort(key) {
    if (sortCol === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(key)
      setSortDir('asc')
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
        <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider">{title}</h2>
        <span className="text-muted text-[12px] font-mono">{rows.length}</span>
        {showFilters && (
          <div className="ml-auto">
            <Segmented options={FILTERS} value={filter} onChange={setFilter} />
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px] font-mono">
          <thead>
            <tr className="bg-raised/50">
              {COLUMNS.map((col) => (
                <th key={col.key} className={th} onClick={() => toggleSort(col.key)}>
                  {col.label}
                  <SortArrow active={sortCol === col.key} dir={sortDir} />
                </th>
              ))}
              <th className="px-3 py-2.5 text-left text-[11px] font-mono font-semibold text-muted uppercase tracking-wider whitespace-nowrap">
                Operation
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((n) => (
              <tr key={n.id} className="hover:bg-raised/60 transition-colors">
                <td className={td}>
                  <span className="font-semibold text-bright">{n.id}</span>
                </td>
                <td className={td}>
                  <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-raised border border-line text-muted">
                    {n.connection ?? 'mTLS'}
                  </span>
                </td>
                <td className={`${td} text-muted`}>{n.externalIp ?? '—'}</td>
                <td className={`${td} text-muted`}>{n.region}</td>
                <td className={`${td} text-accent`}>{n.ip}</td>
                <td className={`${td} text-muted`}>{n.user ?? 'root'}</td>
                <td className={`${td} text-muted`}>{n.hostname ?? '—'}</td>
                <td className={td}>
                  <span className="text-muted">{n.systemType ?? '—'}</span>
                </td>
                <td className={`${td} text-muted`}>{n.processName ?? 'm12-agent'}</td>
                <td className={td}>
                  <StatusBadge status={n.status} />
                </td>
                <td className={td}>
                  <HeartbeatBadge count={n.heartbeats ?? 0} status={n.status} />
                </td>
                <td className={td}>
                  <OpMenu node={n} onTerminal={onTerminal} />
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className={`${td} text-center py-8 text-muted`}>
                  no clients match
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

function HeartbeatBadge({ count, status }) {
  const isOnline = status !== 'offline'
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[28px] h-[22px] rounded-full text-[11px] font-mono font-semibold border ${
        isOnline && count > 0
          ? 'text-ok border-ok/30 bg-ok/10'
          : 'text-muted border-line bg-raised'
      }`}
    >
      {count}
    </span>
  )
}

export function DeploymentsTable({ deployments }) {
  return (
    <section className="card overflow-hidden">
      <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider px-3 pt-3 pb-2">Deployments</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] font-mono">
          <thead>
            <tr className="bg-raised/50">
              <th className={th}>ID</th>
              <th className={th}>Payload</th>
              <th className={th}>Target</th>
              <th className={th}>Status</th>
              <th className={th}>By</th>
              <th className={th}>Time</th>
              <th className={th}>When</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id} className="hover:bg-raised/60 transition-colors">
                <td className={`${td} font-semibold text-bright`}>{d.id}</td>
                <td className={td}>
                  {d.payload} <span className="text-muted">@{d.version}</span>
                </td>
                <td className={`${td} text-accent`}>{d.target}</td>
                <td className={td}>
                  <StatusBadge status={d.status} />
                </td>
                <td className={`${td} text-muted`}>{d.by}</td>
                <td className={`${td} text-muted`}>{d.duration}</td>
                <td className={`${td} text-muted text-[12px]`}>{ago(d.at)}</td>
              </tr>
            ))}
            {deployments.length === 0 && (
              <tr>
                <td colSpan={7} className={`${td} text-center py-8 text-muted`}>
                  no deployments yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
