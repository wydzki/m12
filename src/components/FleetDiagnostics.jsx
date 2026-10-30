import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Radio, Loader2, Upload, Download, ScrollText, ShieldAlert, Settings } from 'lucide-react'
import { StatusBadge } from './ui.jsx'
import { api } from '../api.js'

function ConfirmModal({ info, onConfirm, onCancel }) {
  const [input, setInput] = useState('')
  const [remaining, setRemaining] = useState(60)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    const start = Date.now()
    const id = setInterval(() => {
      const left = Math.max(0, 60 - Math.floor((Date.now() - start) / 1000))
      setRemaining(left)
      if (left === 0) onCancel()
    }, 1000)
    return () => clearInterval(id)
  }, [onCancel])

  const match = input.trim() === String(info.count)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="bg-surface border border-accent/30 p-5 max-w-md w-full mx-4 shadow-[0_4px_24px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="size-5 text-warn" />
          <h3 className="font-mono font-semibold text-[14px] text-warn uppercase tracking-wider">
            Confirm Dispatch
          </h3>
          <span className="ml-auto font-mono text-[12px] text-muted">{remaining}s</span>
        </div>

        <div className="space-y-2 text-[12px] font-mono">
          <div className="flex gap-2">
            <span className="text-muted">type:</span>
            <span className="text-bright uppercase">{info.commandType}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted">selector:</span>
            <span className="text-bright">{typeof info.selector === 'string' ? info.selector : JSON.stringify(info.selector)}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted">targets:</span>
            <span className="text-warn font-semibold">{info.count} agent{info.count !== 1 ? 's' : ''}</span>
          </div>
          {info.skipped?.length > 0 && (
            <div className="flex gap-2">
              <span className="text-muted">skipped (version):</span>
              <span className="text-muted">{info.skipped.length}</span>
            </div>
          )}
        </div>

        <p className="text-[12px] font-mono text-muted mt-4">
          type the target count <span className="text-warn font-semibold">{info.count}</span> to confirm:
        </p>
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (match) onConfirm(info.confirm_token)
          }}
        >
          <input
            ref={inputRef}
            className="field flex-1 text-center text-[16px] font-mono font-semibold tracking-widest"
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="###"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={!match}
            className="btn btn-primary disabled:opacity-40 whitespace-nowrap"
          >
            confirm
          </button>
          <button type="button" onClick={onCancel} className="btn bg-raised text-muted hover:text-bright">
            cancel
          </button>
        </form>
      </div>
    </div>
  )
}

const td = 'px-3 py-2.5 border-t border-line align-top'
const th = 'px-3 py-2.5 text-left text-[11px] font-mono font-semibold text-muted uppercase tracking-wider'

const STATUS = { pending: 'scanning', sent: 'running', done: 'success', expired: 'offline', gone: 'offline' }
const LABEL = { pending: 'Queued', sent: 'Running', done: 'Done', expired: 'Expired', gone: 'Gone' }

const MODES = [
  { id: 'all', label: 'All' },
  { id: 'ids', label: 'By ID' },
  { id: 'filter', label: 'Filter' },
]

export default function FleetDiagnostics({ nodes = [] }) {
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [task, setTask] = useState(null)
  const [mode, setMode] = useState('all')
  const [ids, setIds] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterArch, setFilterArch] = useState('')
  const [filterRegion, setFilterRegion] = useState('')
  const [filterTag, setFilterTag] = useState('')
  const [pushPath, setPushPath] = useState('')
  const [pushFile, setPushFile] = useState(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushResult, setPushResult] = useState(null)
  const [pullPath, setPullPath] = useState('')
  const [pullBusy, setPullBusy] = useState(false)
  const [pullResults, setPullResults] = useState(null)
  const [cfgAddrs, setCfgAddrs] = useState('')
  const [cfgBusy, setCfgBusy] = useState(false)
  const [cfgResult, setCfgResult] = useState(null)
  const [auditEntries, setAuditEntries] = useState(null)
  const [showAudit, setShowAudit] = useState(false)
  const [confirmInfo, setConfirmInfo] = useState(null)
  const pendingAction = useRef(null)
  const taskId = task?.taskId
  const pollRef = useRef(null)
  const activeOpId = useRef(null)

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
      for (const [k, v] of Object.entries(n.tags || {})) {
        set.add(v ? `${k}=${v}` : k)
      }
    }
    return [...set].sort()
  }, [nodes])

  function buildSelector() {
    if (mode === 'all') return 'all'
    if (mode === 'ids') {
      const list = ids
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
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
    if (mode === 'all') return nodes.length
    if (mode === 'ids') {
      const list = ids
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
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
  }, [mode, ids, filterStatus, filterArch, filterRegion, filterTag, nodes])

  useEffect(() => {
    if (!showAudit) return
    const load = async () => {
      const r = await api.audit()
      if (r.ok) setAuditEntries(r.data?.entries || [])
    }
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [showAudit])

  useEffect(() => {
    if (!taskId) return
    const tick = async () => {
      const r = await api.fleetTask(taskId)
      if (r.ok) setTask(r.data)
    }
    tick()
    pollRef.current = setInterval(tick, 2000)
    return () => clearInterval(pollRef.current)
  }, [taskId])


  useEffect(() => {
    const opId = activeOpId.current
    if (!opId) return
    const hb = setInterval(() => api.opHeartbeat(opId).catch(() => {}), 15_000)
    return () => {
      clearInterval(hb)
      api.opClose(opId).catch(() => {})
      activeOpId.current = null
    }
  }, [taskId])

  async function dryRunThenDispatch(commandType, dispatchFn) {
    const selector = buildSelector()
    const dr = await api.fleetDryRun(selector, commandType)
    if (!dr.ok) return { ok: false, error: dr.data?.error || `dry-run failed (${dr.status})` }
    if (dr.data.confirmRequired) {
      return new Promise((resolve) => {
        pendingAction.current = { resolve, dispatchFn, dryRun: dr.data }
        setConfirmInfo(dr.data)
      })
    }
    return dispatchFn(dr.data.confirm_token)
  }

  function handleConfirm(token) {
    const action = pendingAction.current
    setConfirmInfo(null)
    pendingAction.current = null
    if (action) action.resolve(action.dispatchFn(token))
  }

  function handleCancelConfirm() {
    const action = pendingAction.current
    setConfirmInfo(null)
    pendingAction.current = null
    if (action) action.resolve({ ok: false, error: 'cancelled' })
  }

  async function broadcast(e) {
    e.preventDefault()
    const cmd = command.trim()
    if (!cmd || busy) return
    const selector = buildSelector()
    if (mode === 'ids' && Array.isArray(selector) && selector.length === 0) {
      setError('no node IDs specified')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await dryRunThenDispatch('exec', async (token) => {
        const r = await api.fleetExec(cmd, selector, token)
        if (!r.ok) return { ok: false, error: r.data?.error || `failed (${r.status})` }
        return { ok: true, data: r.data }
      })
      if (!result.ok) {
        if (result.error !== 'cancelled') setError(result.error)
        return
      }
      if (result.data?.operationId) activeOpId.current = result.data.operationId
      setTask({ taskId: result.data.taskId, command: cmd, nodes: [] })
    } catch {
      setError('connection failed.')
    } finally {
      setBusy(false)
    }
  }

  const done = task ? task.nodes.filter((n) => n.status === 'done').length : 0

  async function handlePush(e) {
    e.preventDefault()
    if (!pushFile || !pushPath.trim() || pushBusy) return
    setPushBusy(true)
    setPushResult(null)
    try {
      const buf = await pushFile.arrayBuffer()
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      const selector = buildSelector()
      const result = await dryRunThenDispatch('file_push', async (token) => {
        const r = await api.filePush(pushPath.trim(), b64, selector, token)
        return r.ok ? { ok: true, ...r.data } : { ok: false, error: r.data?.error || `failed (${r.status})` }
      })
      if (result?.operationId) activeOpId.current = result.operationId
      if (result.error !== 'cancelled') setPushResult(result)
    } catch {
      setPushResult({ ok: false, error: 'connection failed.' })
    } finally {
      setPushBusy(false)
    }
  }

  async function handlePull(e) {
    e.preventDefault()
    if (!pullPath.trim() || pullBusy) return
    setPullBusy(true)
    setPullResults(null)
    try {
      const selector = buildSelector()
      const result = await dryRunThenDispatch('file_pull', async (token) => {
        const r = await api.filePull(pullPath.trim(), selector, token)
        return r.ok ? { ok: true, ...r.data } : { ok: false, error: r.data?.error || `failed (${r.status})` }
      })
      if (result?.operationId) activeOpId.current = result.operationId
      if (result.error !== 'cancelled') setPullResults(result)
    } catch {
      setPullResults({ ok: false, error: 'connection failed.' })
    } finally {
      setPullBusy(false)
    }
  }

  async function handleConfigPush(e) {
    e.preventDefault()
    if (!cfgAddrs.trim() || cfgBusy) return
    setCfgBusy(true)
    setCfgResult(null)
    try {
      const addresses = cfgAddrs.split(',').map((s) => s.trim()).filter(Boolean)
      if (addresses.length === 0 || addresses.length > 8) {
        setCfgResult({ ok: false, error: 'Provide 1-8 addresses (host:port, comma-separated).' })
        return
      }
      const selector = buildSelector()
      const result = await dryRunThenDispatch('config_update', async (token) => {
        const r = await api.configPush(addresses, selector, token)
        return r.ok ? { ok: true, ...r.data } : { ok: false, error: r.data?.error || `failed (${r.status})` }
      })
      if (result.error !== 'cancelled') setCfgResult(result)
    } catch {
      setCfgResult({ ok: false, error: 'connection failed.' })
    } finally {
      setCfgBusy(false)
    }
  }

  async function downloadPull(fileId) {
    const r = await api.fileDownload(fileId)
    if (!r.ok || !r.data?.data) return
    const bytes = Uint8Array.from(atob(r.data.data), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes])
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = r.data.path?.split('/').pop() || 'file'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-3 max-w-4xl">
      <section className="card p-4">
        <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider flex items-center gap-2">
          <Radio className="size-4 text-accent" /> MIPS C2
        </h2>
        <p className="text-muted text-[12px] font-mono mt-1">
          dispatch a command to selected clients. executes on next mTLS check-in.
        </p>

        {/* selector */}
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-1">
            <span className="text-muted text-[11px] font-mono uppercase tracking-wider mr-2">target:</span>
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`px-2 py-1 text-[11px] font-mono uppercase tracking-wider border border-line ${
                  mode === m.id ? 'bg-accent text-white' : 'bg-raised text-muted hover:text-bright'
                }`}
              >
                {m.label}
              </button>
            ))}
            <span className="text-muted text-[11px] font-mono ml-2">
              {matched}/{nodes.length} clients
            </span>
          </div>

          {mode === 'ids' && (
            <input
              className="field w-full text-[12px]"
              placeholder="node-0007a1b2c3d4, node-00112233aabb, ..."
              value={ids}
              onChange={(e) => setIds(e.target.value)}
              spellCheck={false}
            />
          )}

          {mode === 'filter' && (
            <div className="flex flex-wrap gap-2">
              <select
                className="field text-[12px]"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="">any status</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                className="field text-[12px]"
                value={filterArch}
                onChange={(e) => setFilterArch(e.target.value)}
              >
                <option value="">any arch</option>
                {archs.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              {regions.length > 0 && (
                <select
                  className="field text-[12px]"
                  value={filterRegion}
                  onChange={(e) => setFilterRegion(e.target.value)}
                >
                  <option value="">any region</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
              {tagPairs.length > 0 && (
                <select
                  className="field text-[12px]"
                  value={filterTag}
                  onChange={(e) => setFilterTag(e.target.value)}
                >
                  <option value="">any tag</option>
                  {tagPairs.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        <form onSubmit={broadcast} className="mt-3 flex items-center gap-2">
          <span className="font-mono text-accent text-[13px]">$</span>
          <input
            className="field flex-1"
            placeholder="uptime"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={busy || matched === 0}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-60 whitespace-nowrap"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Radio className="size-3.5" />}
            dispatch
          </button>
        </form>
        {error && <p className="text-bad text-[12px] font-mono mt-2">{error}</p>}
      </section>

      {/* file push */}
      <section className="card p-4">
        <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider flex items-center gap-2">
          <Upload className="size-4 text-accent" /> File Push
        </h2>
        <p className="text-muted text-[12px] font-mono mt-1">
          push a file to selected agents. uses selector above.
        </p>
        <form onSubmit={handlePush} className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              className="field flex-1 text-[12px]"
              placeholder="/tmp/firmware.bin"
              value={pushPath}
              onChange={(e) => setPushPath(e.target.value)}
              spellCheck={false}
            />
            <label className="btn bg-raised text-muted hover:text-bright text-[12px] cursor-pointer">
              {pushFile ? pushFile.name : 'choose file'}
              <input type="file" className="hidden" onChange={(e) => setPushFile(e.target.files?.[0] || null)} />
            </label>
            <button
              type="submit"
              disabled={pushBusy || !pushFile || !pushPath.trim() || matched === 0}
              className="btn btn-primary flex items-center gap-2 disabled:opacity-60 whitespace-nowrap"
            >
              {pushBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              push
            </button>
          </div>
          {pushFile && (
            <span className="text-muted text-[11px] font-mono">
              {pushFile.name} ({(pushFile.size / 1024).toFixed(1)} KB) → {matched} client{matched !== 1 ? 's' : ''}
            </span>
          )}
        </form>
        {pushResult && (
          <p className={`text-[12px] font-mono mt-2 ${pushResult.ok ? 'text-good' : 'text-bad'}`}>
            {pushResult.ok
              ? `queued: ${pushResult.count} agent${pushResult.count !== 1 ? 's' : ''}, sha256=${pushResult.sha256?.slice(0, 16)}..`
              : pushResult.error}
          </p>
        )}
      </section>

      {/* file pull */}
      <section className="card p-4">
        <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider flex items-center gap-2">
          <Download className="size-4 text-accent" /> File Pull
        </h2>
        <p className="text-muted text-[12px] font-mono mt-1">
          pull a file from selected agents. uses selector above.
        </p>
        <form onSubmit={handlePull} className="mt-3 flex items-center gap-2">
          <input
            className="field flex-1 text-[12px]"
            placeholder="/etc/config/wireless"
            value={pullPath}
            onChange={(e) => setPullPath(e.target.value)}
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={pullBusy || !pullPath.trim() || matched === 0}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-60 whitespace-nowrap"
          >
            {pullBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            pull
          </button>
        </form>
        {pullResults && !pullResults.ok && (
          <p className="text-bad text-[12px] font-mono mt-2">{pullResults.error}</p>
        )}
        {pullResults?.ok && pullResults.pulls && (
          <div className="mt-2 space-y-1">
            {pullResults.pulls.map((p) => (
              <div key={p.fileId} className="flex items-center gap-2 text-[12px] font-mono">
                <span className="text-bright">{p.nodeId}</span>
                <button
                  type="button"
                  onClick={() => downloadPull(p.fileId)}
                  className="text-accent hover:underline"
                >
                  download
                </button>
              </div>
            ))}
            <p className="text-muted text-[11px] font-mono">
              files available after agent check-in (~60s). click download to save.
            </p>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h3 className="font-mono font-semibold text-[13px] text-bright flex items-center gap-2 mb-3">
          <Settings className="size-4 text-accent" /> Config Push
        </h3>
        <form onSubmit={handleConfigPush} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-[10px] font-mono text-muted uppercase mb-1">C2 Addresses (host:port, comma-separated)</label>
            <input
              className="w-full bg-raised border border-line px-2 py-1 font-mono text-[12px] text-bright placeholder:text-muted/50 outline-none focus:border-accent"
              placeholder="primary:8443,fallback1:8443,fallback2:8443"
              value={cfgAddrs}
              onChange={(e) => setCfgAddrs(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={cfgBusy || !cfgAddrs.trim() || matched === 0}
            className="btn btn-primary px-3 py-1 text-[12px] font-mono disabled:opacity-50 cursor-pointer"
          >
            {cfgBusy ? <Loader2 className="size-3 animate-spin" /> : 'push config'}
          </button>
        </form>
        {cfgResult && !cfgResult.ok && (
          <p className="text-bad text-[12px] font-mono mt-2">{cfgResult.error}</p>
        )}
        {cfgResult?.ok && (
          <p className="text-ok text-[12px] font-mono mt-2">
            config_update dispatched to {cfgResult.count} agent(s) — addresses: {cfgResult.addresses?.join(', ')}
          </p>
        )}
      </section>

      {task && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
            <h3 className="font-mono font-semibold text-[13px] text-bright">
              $ <span className="text-accent">{task.command}</span>
            </h3>
            <span className="text-muted text-[12px] font-mono">
              {done}/{task.nodes.length} responded
            </span>
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
                      queued — waiting for clients to check in...
                    </td>
                  </tr>
                )}
                {task.nodes.map((n) => (
                  <tr key={n.nodeId} className="hover:bg-raised/60 transition-colors">
                    <td className={`${td} font-semibold text-bright whitespace-nowrap`}>{n.nodeId}</td>
                    <td className={td}>
                      <StatusBadge status={STATUS[n.status] || 'offline'} />
                      {n.status === 'done' && n.exitCode !== null && (
                        <span className="text-muted text-[11px] ml-2">exit {n.exitCode}</span>
                      )}
                    </td>
                    <td className={td}>
                      {n.output != null ? (
                        <pre className="text-[12px] whitespace-pre-wrap break-words max-h-40 overflow-auto bg-page text-ink rounded p-2 border border-line">
                          {n.output || '(no output)'}
                        </pre>
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

      {/* audit log */}
      <section className="card overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAudit((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-3 text-left hover:bg-raised/40"
        >
          <ScrollText className="size-4 text-accent" />
          <span className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider">
            Audit Log
          </span>
          <span className="text-muted text-[11px] font-mono ml-auto">{showAudit ? '▲' : '▼'}</span>
        </button>
        {showAudit && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] font-mono">
              <thead>
                <tr className="bg-raised/50">
                  <th className={th}>Time</th>
                  <th className={th}>Operator</th>
                  <th className={th}>Type</th>
                  <th className={th}>Targets</th>
                  <th className={th}>Selector</th>
                  <th className={th}>Command</th>
                  <th className={th}>Duration</th>
                </tr>
              </thead>
              <tbody>
                {!auditEntries && (
                  <tr>
                    <td colSpan={7} className={`${td} text-center py-4 text-muted`}>
                      loading...
                    </td>
                  </tr>
                )}
                {auditEntries?.length === 0 && (
                  <tr>
                    <td colSpan={7} className={`${td} text-center py-4 text-muted`}>
                      no dispatches yet
                    </td>
                  </tr>
                )}
                {auditEntries?.map((e) => (
                  <tr key={e.id} className="hover:bg-raised/60">
                    <td className={`${td} text-muted whitespace-nowrap`}>
                      {new Date(e.ts).toLocaleTimeString()}
                    </td>
                    <td className={`${td} text-bright`}>{e.operator}</td>
                    <td className={td}>
                      <span
                        className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wider border border-line ${
                          e.commandType === 'exec'
                            ? 'text-accent'
                            : e.commandType === 'file_push'
                              ? 'text-warn'
                              : 'text-good'
                        }`}
                      >
                        {e.commandType}
                      </span>
                    </td>
                    <td className={`${td} text-bright`}>{e.targetCount}</td>
                    <td className={`${td} text-muted max-w-[160px] truncate`}>{e.selector}</td>
                    <td className={`${td} text-ink max-w-[200px] truncate`}>{e.command || '—'}</td>
                    <td className={`${td} text-muted whitespace-nowrap`}>
                      {e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirmInfo && (
        <ConfirmModal info={confirmInfo} onConfirm={handleConfirm} onCancel={handleCancelConfirm} />
      )}
    </div>
  )
}
