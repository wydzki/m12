import { useEffect, useRef, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { api } from '../api.js'

export default function NodeTerminal({ nodeId, initialCommand, onClose }) {
  const [command, setCommand] = useState('')
  const [commands, setCommands] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const sentInitial = useRef(false)

  async function refresh() {
    const r = await api.nodeExec(nodeId)
    if (r.ok) setCommands(r.data.commands || [])
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  useEffect(() => {
    if (initialCommand && !sentInitial.current) {
      sentInitial.current = true
      api.runCommand(nodeId, initialCommand).then(() => refresh())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCommand, nodeId])

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
      if (!r.ok) setError(r.data?.error || `failed (${r.status})`)
      else {
        setCommand('')
        refresh()
      }
    } catch {
      setError('connection failed.')
    } finally {
      setBusy(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') onClose()
  }

  const label = { pending: 'QUEUED', sent: 'SENT', done: 'DONE', expired: 'EXPIRED' }

  return (
    <div
      className="fixed inset-0 z-30 bg-page flex flex-col"
      onClick={() => inputRef.current?.focus()}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-line shrink-0">
        <div className="font-mono text-[12px] flex items-center gap-2">
          <span className="text-accent font-semibold">root@{nodeId}</span>
          <span className="text-muted text-[10px]">| commands execute on next check-in (~60s)</span>
        </div>
        <button
          onClick={onClose}
          className="px-2 py-0.5 text-muted hover:text-bad font-mono text-[12px] hover:bg-raised cursor-pointer border border-transparent hover:border-line"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[12px] leading-relaxed p-3 bg-page">
        {commands.length === 0 && !initialCommand && (
          <div className="text-muted">&gt; no commands queued. type below.</div>
        )}
        {commands
          .slice()
          .reverse()
          .map((c) => (
            <div key={c.id} className="mb-3">
              <div className="flex items-center gap-2">
                <span className="text-accent select-none">$</span>
                <span className="text-bright break-all">{c.command}</span>
                <span
                  className={`ml-auto text-[9px] uppercase tracking-wider font-semibold ${
                    c.status === 'done' ? 'text-ok' : 'text-warn'
                  }`}
                >
                  {c.status !== 'done' && <Loader2 className="inline size-2.5 animate-spin mr-1" />}
                  [{label[c.status] || c.status}
                  {c.status === 'done' && c.exitCode !== null ? `:${c.exitCode}` : ''}]
                </span>
              </div>
              {c.output != null && (
                <pre className="mt-1 whitespace-pre-wrap break-words text-ink/80 pl-3 border-l border-accent/20 ml-1">
                  {c.output || '(no output)'}
                </pre>
              )}
            </div>
          ))}
      </div>

      <form onSubmit={run} className="border-t border-line px-3 py-2 bg-surface shrink-0">
        {error && <p className="text-bad text-[11px] font-mono mb-1.5">{error}</p>}
        <div className="flex items-center gap-2">
          <span className="font-mono text-accent text-[12px] font-semibold select-none">$</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none font-mono text-[12px] text-bright placeholder:text-muted/50"
            placeholder="type a command..."
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            autoFocus
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary px-3 py-1 text-[11px] disabled:opacity-50 cursor-pointer"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : 'run'}
          </button>
        </div>
      </form>
    </div>
  )
}
