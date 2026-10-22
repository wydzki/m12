export function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s} secs ago`
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? '1 min ago' : `${m} mins ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

// timeline-style: 45s, 2m, 3h, 1d
export function shortAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// 4chan-banner style wordmark: maroon Tahoma, tight tracking, salmon offset shadow
const LOGO = {
  sm: { word: 'text-[30px] tracking-[-2px] drop-shadow-[1px_1px_0_#eeaa88]', tag: 'text-[7px] mb-0.5' },
  md: { word: 'text-[56px] tracking-[-4px] drop-shadow-[2px_2px_0_#eeaa88]', tag: 'text-[10px] mb-1' },
  xl: { word: 'text-[180px] tracking-[-12px] drop-shadow-[6px_6px_0_#eeaa88]', tag: 'text-[22px] mb-6' },
}

export function Logo({ size = 'sm', tagline = false }) {
  const s = LOGO[size]
  return (
    <span className="inline-flex items-end gap-2 select-none">
      <span className={`font-banner font-bold leading-none text-maroon ${s.word}`}>m12</span>
      {tagline && (
        <span className={`uppercase tracking-widest text-maroon/70 leading-tight ${s.tag}`}>
          network
          <br />
          analyzer
        </span>
      )}
    </span>
  )
}

export function Avatar({ name, size = 'size-9' }) {
  return (
    <div className={`${size} shrink-0 rounded-full bg-accent text-white grid place-items-center font-bold text-[13px]`}>
      {name.slice(0, 2).toUpperCase()}
    </div>
  )
}

const STATUS = {
  healthy: { label: 'Healthy', cls: 'text-ok bg-ok/10' },
  success: { label: 'Success', cls: 'text-ok bg-ok/10' },
  scanning: { label: 'Scanning', cls: 'text-accent bg-accent/10', pulse: true },
  running: { label: 'Running', cls: 'text-accent bg-accent/10', pulse: true },
  offline: { label: 'Offline', cls: 'text-muted bg-line' },
  failed: { label: 'Failed', cls: 'text-bad bg-bad/10' },
}

export function StatusBadge({ status }) {
  const s = STATUS[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap ${s.cls}`}>
      <span className={`size-1.5 rounded-full bg-current ${s.pulse ? 'animate-pulse' : ''}`} />
      {s.label}
    </span>
  )
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="inline-flex rounded-full bg-soft p-0.5 text-[13px]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 font-semibold cursor-pointer transition-colors ${
            o.value === value ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Pager({ page, pages, onPage }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-line text-[13px]">
      <span className="text-muted">
        Page {page + 1} of {pages}
      </span>
      <div className="flex gap-2">
        <button className="pill pill-outline py-1 px-3 disabled:opacity-40" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="pill pill-outline py-1 px-3 disabled:opacity-40" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  )
}
