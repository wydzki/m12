import { useEffect, useRef, useState } from 'react'
import { X, CornerDownLeft, Loader2 } from 'lucide-react'
import { api } from '../api.js'

// Remote diagnostics terminal for one node. Commands are queued server-side and
// delivered to the node the next time it checks in over mTLS, so output appears
// after the node's next poll — not instantly.
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
    const t = setInterval(refresh, 2000) // poll for output as the node reports back
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
        setError(r.data?.error || `Failed (${r.status}).`)
      } else {
        setCommand('')
        refresh()
      }
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const label = { pending: 'queued', sent: 'running', done: 'done', expired: 'expired' }

  return (
    <div className="fixed inset-0 z-30 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div>
            <h2 className="font-bold text-[16px]">Diagnostics — <span className="font-mono">{nodeId}</span></h2>
            <p className="text-muted text-[12px]">Commands run on the node after its next mTLS check-in.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full text-muted hover:bg-soft hover:text-ink cursor-pointer" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto bg-ink text-[#e6e6e6] font-mono text-[12.5px] leading-relaxed p-3 space-y-3">
          {commands.length === 0 && <div className="text-[#8899a6]">No commands yet. Type one below.</div>}
          {commands
            .slice()
            .reverse()
            .map((c) => (
              <div key={c.id}>
                <div className="flex items-center gap-2">
                  <span className="text-[#5fb3f0]">$</span>
                  <span className="break-all">{c.command}</span>
                  <span className={`ml-auto text-[10px] uppercase tracking-wide ${c.status === 'done' ? 'text-ok' : 'text-[#c9a227]'}`}>
                    {c.status !== 'done' && <Loader2 className="inline size-3 animate-spin mr-1" />}
                    {label[c.status] || c.status}
                    {c.status === 'done' && c.exitCode !== null ? ` · exit ${c.exitCode}` : ''}
                  </span>
                </div>
                {c.output != null && <pre className="mt-1 whitespace-pre-wrap break-words text-[#d7dbdd]">{c.output || '(no output)'}</pre>}
              </div>
            ))}
        </div>

        <form onSubmit={run} className="border-t border-line p-3">
          {error && <p className="text-bad text-[13px] mb-2">{error}</p>}
          <div className="flex items-center gap-2">
            <span className="font-mono text-muted">$</span>
            <input
              className="field font-mono flex-1"
              placeholder="e.g. uptime"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              autoFocus
              spellCheck={false}
            />
            <button type="submit" disabled={busy} className="pill pill-dark flex items-center gap-1.5 disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />}
              Run
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
