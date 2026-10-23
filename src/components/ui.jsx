export function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export function shortAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function Logo({ size = 'sm', tagline = false }) {
  const sizes = {
    sm: 'text-[20px]',
    md: 'text-[36px]',
    xl: 'text-[72px]',
  }
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <span className={`font-mono font-bold leading-none text-accent ${sizes[size]}`}>
        m12<span className="text-muted">_</span>
      </span>
      {tagline && (
        <span className="text-muted text-[11px] font-mono uppercase tracking-widest">
          fleet<br />control
        </span>
      )}
    </span>
  )
}

export function Avatar({ name, size = 'size-7' }) {
  return (
    <div className={`${size} shrink-0 rounded bg-raised border border-line text-accent grid place-items-center font-mono font-bold text-[11px]`}>
      {name.slice(0, 2).toUpperCase()}
    </div>
  )
}

const STATUS = {
  healthy: { label: 'ONLINE', cls: 'text-ok border-ok/30 bg-ok/8' },
  success: { label: 'OK', cls: 'text-ok border-ok/30 bg-ok/8' },
  scanning: { label: 'ACTIVE', cls: 'text-blue border-blue/30 bg-blue/8', pulse: true },
  running: { label: 'RUNNING', cls: 'text-warn border-warn/30 bg-warn/8', pulse: true },
  offline: { label: 'OFFLINE', cls: 'text-muted border-line bg-raised' },
  failed: { label: 'FAILED', cls: 'text-bad border-bad/30 bg-bad/8' },
}

export function StatusBadge({ status }) {
  const s = STATUS[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-mono font-semibold uppercase tracking-wider whitespace-nowrap ${s.cls}`}>
      <span className={`size-1.5 rounded-full bg-current ${s.pulse ? 'animate-pulse' : ''}`} />
      {s.label}
    </span>
  )
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="inline-flex rounded border border-line bg-page text-[12px] font-mono">
      {options.map((o, i) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 cursor-pointer transition-colors ${
            i > 0 ? 'border-l border-line' : ''
          } ${o.value === value ? 'bg-raised text-accent font-semibold' : 'text-muted hover:text-ink hover:bg-surface'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Pager({ page, pages, onPage }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-line text-[12px] font-mono">
      <span className="text-muted">
        {page + 1}/{pages}
      </span>
      <div className="flex gap-2">
        <button className="btn btn-ghost py-1 px-3 text-[12px] disabled:opacity-30" disabled={page === 0} onClick={() => onPage(page - 1)}>
          prev
        </button>
        <button className="btn btn-ghost py-1 px-3 text-[12px] disabled:opacity-30" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          next
        </button>
      </div>
    </div>
  )
}
