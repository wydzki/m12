import { useEffect, useRef, useState } from 'react'
import { X, CornerDownLeft, Loader2 } from 'lucide-react'
import { api } from '../api.js'

export default function NodeTerminal({ nodeId, onClose }) {
  const [command, setCommand] = useState('')
  const [commands, setCommands] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)

  async function refresh() {
    const r = await api.nodeExec(nodeId)
    if (r.ok) setCommands(r.data.commands || [])
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [commands])

  async function run(e) {
    e.preventDefault()
    const cmd = command.trim()
    if (!cmd || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await api.runCommand(nodeId, cmd)
      if (!r.ok) {
        setError(r.data?.error || `failed (${r.status})`)
      } else {
        setCommand('')
        refresh()
      }
    } catch {
      setError('connection failed.')
    } finally {
      setBusy(false)
    }
  }

  const label = { pending: 'queued', sent: 'running', done: 'done', expired: 'expired' }

  return (
    <div className="fixed inset-0 z-30 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl flex flex-col max-h-[85vh] border-accent/30" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-line">
          <div>
            <h2 className="font-mono font-semibold text-[13px] text-accent">{nodeId}</h2>
            <p className="text-muted text-[11px] font-mono">commands execute on next mTLS check-in</p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-muted hover:bg-raised hover:text-ink cursor-pointer" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto bg-page font-mono text-[12px] leading-relaxed p-3 space-y-3">
          {commands.length === 0 && <div className="text-muted">no commands queued. type one below.</div>}
          {commands
            .slice()
            .reverse()
            .map((c) => (
              <div key={c.id}>
                <div className="flex items-center gap-2">
                  <span className="text-accent">$</span>
                  <span className="text-bright break-all">{c.command}</span>
                  <span className={`ml-auto text-[10px] uppercase tracking-wider font-semibold ${c.status === 'done' ? 'text-ok' : 'text-warn'}`}>
                    {c.status !== 'done' && <Loader2 className="inline size-3 animate-spin mr-1" />}
                    {label[c.status] || c.status}
                    {c.status === 'done' && c.exitCode !== null ? ` · ${c.exitCode}` : ''}
                  </span>
                </div>
                {c.output != null && <pre className="mt-1 whitespace-pre-wrap break-words text-ink">{c.output || '(no output)'}</pre>}
              </div>
            ))}
        </div>

        <form onSubmit={run} className="border-t border-line p-3">
          {error && <p className="text-bad text-[12px] font-mono mb-2">{error}</p>}
          <div className="flex items-center gap-2">
            <span className="font-mono text-accent text-[13px]">$</span>
            <input
              className="field flex-1"
              placeholder="uptime"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              autoFocus
              spellCheck={false}
            />
            <button type="submit" disabled={busy} className="btn btn-primary flex items-center gap-1.5 disabled:opacity-60">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CornerDownLeft className="size-3.5" />}
              run
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
