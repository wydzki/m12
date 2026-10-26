import { useEffect, useMemo, useState, useCallback } from 'react'
import { StatusBadge, Pager, Segmented, ago } from './ui.jsx'

const th = 'px-2 py-1.5 text-left text-[10px] font-mono font-semibold text-muted uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-ink'
const td = 'px-2 py-1.5 border-t border-line whitespace-nowrap'

const FILTERS = ['all', 'healthy', 'scanning', 'offline'].map((f) => ({ value: f, label: f }))

const COLUMNS = [
  { key: 'id', label: 'ID', sortKey: (n) => n.id },
  { key: 'connection', label: 'Conn', sortKey: (n) => n.connection ?? '' },
  { key: 'externalIp', label: 'External IP', sortKey: (n) => n.externalIp ?? '' },
  { key: 'region', label: 'Region', sortKey: (n) => n.region ?? '' },
  { key: 'ip', label: 'Intranet IP', sortKey: (n) => n.ip },
  { key: 'user', label: 'User', sortKey: (n) => n.user ?? '' },
  { key: 'hostname', label: 'Host', sortKey: (n) => n.hostname ?? '' },
  { key: 'systemType', label: 'System', sortKey: (n) => n.systemType ?? '' },
  { key: 'processName', label: 'Proc', sortKey: (n) => n.processName ?? '' },
  { key: 'status', label: 'Status', sortKey: (n) => n.status },
  { key: 'heartbeats', label: 'HB', sortKey: (n) => n.heartbeats ?? 0 },
]

function SortArrow({ active, dir }) {
  return (
    <span className={`inline-flex flex-col ml-1 leading-none ${active ? 'text-accent' : 'text-muted/40'}`}>
      <span className={`text-[7px] ${active && dir === 'asc' ? 'text-accent' : ''}`}>&#9650;</span>
      <span className={`text-[7px] -mt-0.5 ${active && dir === 'desc' ? 'text-accent' : ''}`}>&#9660;</span>
    </span>
  )
}

function ContextMenu({ x, y, node, onShell, onCheckDir, onRemove, onClose }) {
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  const items = [
    { label: '> Shell', fn: () => onShell?.(node.id), ok: node.status !== 'offline' && !!onShell },
    { label: '> Check Directory', fn: () => onCheckDir?.(node.id), ok: node.status !== 'offline' && !!onCheckDir },
    { label: '> Drop File', fn: null, ok: false },
    { label: '> Upload File', fn: null, ok: false },
    { sep: true },
    { label: '> Remove', fn: () => onRemove?.(node.id), ok: !!onRemove, danger: true },
  ]

  return (
    <div
      className="fixed z-50 bg-surface border border-accent/30 py-1 min-w-[180px] font-mono text-[12px] shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 200) }}
    >
      <div className="px-3 py-1 text-[10px] text-accent uppercase tracking-wider border-b border-line mb-1">
        {node.id}
      </div>
      {items.map((item, i) =>
        item.sep ? (
          <div key={i} className="border-t border-line my-1" />
        ) : (
          <button
            key={i}
            onClick={(e) => {
              e.stopPropagation()
              if (item.ok) {
                item.fn()
                onClose()
              }
            }}
            disabled={!item.ok}
            className={`w-full text-left px-3 py-1 ${
              !item.ok
                ? 'text-muted/30 cursor-default'
                : item.danger
                  ? 'text-bad hover:bg-bad/10 cursor-pointer'
                  : 'text-ink hover:bg-accent/10 hover:text-accent cursor-pointer'
            }`}
          >
            {item.label}
            {!item.ok && !item.danger ? ' [soon]' : ''}
          </button>
        ),
      )}
    </div>
  )
}

export function NodesTable({
  nodes,
  resetKey,
  pageSize = 15,
  showFilters = false,
  title = 'Clients',
  onTerminal,
  onCheckDir,
  onRemoveNode,
}) {
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('all')
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [ctx, setCtx] = useState(null)

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
    if (sortCol === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(key)
      setSortDir('asc')
    }
  }

  const handleContext = useCallback((e, node) => {
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY, node })
  }, [])

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-2 pt-2 pb-1">
        <h2 className="font-mono font-semibold text-[11px] text-accent uppercase tracking-wider">{title}</h2>
        <span className="text-muted text-[11px] font-mono">[{rows.length}]</span>
        <span className="text-muted/30 text-[10px] font-mono ml-1">right-click for options</span>
        {showFilters && (
          <div className="ml-auto">
            <Segmented options={FILTERS} value={filter} onChange={setFilter} />
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="bg-raised/50">
              {COLUMNS.map((col) => (
                <th key={col.key} className={th} onClick={() => toggleSort(col.key)}>
                  {col.label}
                  <SortArrow active={sortCol === col.key} dir={sortDir} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((n) => (
              <tr
                key={n.id}
                className="hover:bg-accent/5 cursor-default"
                onContextMenu={(e) => handleContext(e, n)}
              >
                <td className={td}>
                  <span className="font-semibold text-accent">{n.id}</span>
                </td>
                <td className={td}>
                  <span className="text-[9px] px-1 py-0.5 bg-raised border border-line text-muted">
                    {n.connection ?? 'mTLS'}
                  </span>
                </td>
                <td className={`${td} text-muted`}>{n.externalIp ?? '—'}</td>
                <td className={`${td} text-muted`}>{n.region}</td>
                <td className={`${td} text-accent/70`}>{n.ip}</td>
                <td className={`${td} text-muted`}>{n.user ?? 'root'}</td>
                <td className={`${td} text-muted`}>{n.hostname ?? '—'}</td>
                <td className={`${td} text-muted`}>{n.systemType ?? '—'}</td>
                <td className={`${td} text-muted`}>{n.processName ?? 'm12-agent'}</td>
                <td className={td}>
                  <StatusBadge status={n.status} />
                </td>
                <td className={td}>
                  <HBBadge count={n.heartbeats ?? 0} status={n.status} />
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className={`${td} text-center py-4 text-muted`}>
                  no clients match
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} />}

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          node={ctx.node}
          onShell={onTerminal}
          onCheckDir={onCheckDir}
          onRemove={onRemoveNode}
          onClose={() => setCtx(null)}
        />
      )}
    </section>
  )
}

function HBBadge({ count, status }) {
  const on = status !== 'offline'
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[22px] h-[16px] text-[9px] font-mono font-semibold border ${
        on && count > 0 ? 'text-ok border-ok/30 bg-ok/10' : 'text-muted border-line bg-raised'
      }`}
    >
      {count}
    </span>
  )
}

export function DeploymentsTable({ deployments }) {
  return (
    <section className="card overflow-hidden">
      <h2 className="font-mono font-semibold text-[11px] text-accent uppercase tracking-wider px-2 pt-2 pb-1">
        Deployments
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
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
              <tr key={d.id} className="hover:bg-accent/5">
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
                <td className={`${td} text-muted text-[10px]`}>{ago(d.at)}</td>
              </tr>
            ))}
            {deployments.length === 0 && (
              <tr>
                <td colSpan={7} className={`${td} text-center py-4 text-muted`}>
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
