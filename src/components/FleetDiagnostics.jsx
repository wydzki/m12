import { useEffect, useRef, useState } from 'react'
import { Radio, Loader2 } from 'lucide-react'
import { StatusBadge } from './ui.jsx'
import { api } from '../api.js'

const td = 'px-3 py-2.5 border-t border-line align-top'
const th = 'px-3 py-2.5 text-left text-[11px] font-mono font-semibold text-muted uppercase tracking-wider'

const STATUS = { pending: 'scanning', sent: 'running', done: 'success', expired: 'offline', gone: 'offline' }
const LABEL = { pending: 'Queued', sent: 'Running', done: 'Done', expired: 'Expired', gone: 'Gone' }

export default function FleetDiagnostics() {
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [task, setTask] = useState(null)
  const taskId = task?.taskId
  const pollRef = useRef(null)

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

  async function broadcast(e) {
    e.preventDefault()
    const cmd = command.trim()
    if (!cmd || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await api.fleetExec(cmd)
      if (!r.ok) {
        setError(r.data?.error || `failed (${r.status})`)
        return
      }
      setTask({ taskId: r.data.taskId, command: cmd, nodes: [] })
    } catch {
      setError('connection failed.')
    } finally {
      setBusy(false)
    }
  }

  const done = task ? task.nodes.filter((n) => n.status === 'done').length : 0

  return (
    <div className="space-y-3 max-w-4xl">
      <section className="card p-4">
        <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider flex items-center gap-2">
          <Radio className="size-4 text-accent" /> Fleet Broadcast
        </h2>
        <p className="text-muted text-[12px] font-mono mt-1">
          queue a command for every reporting node. executes on next mTLS check-in.
        </p>
        <form onSubmit={broadcast} className="mt-3 flex items-center gap-2">
          <span className="font-mono text-accent text-[13px]">$</span>
          <input
            className="field flex-1"
            placeholder="uptime"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" disabled={busy} className="btn btn-primary flex items-center gap-2 disabled:opacity-60 whitespace-nowrap">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Radio className="size-3.5" />}
            broadcast
          </button>
        </form>
        {error && <p className="text-bad text-[12px] font-mono mt-2">{error}</p>}
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
                  <th className={th}>Node</th>
                  <th className={th}>Status</th>
                  <th className={th}>Output</th>
                </tr>
              </thead>
              <tbody>
                {task.nodes.length === 0 && (
                  <tr>
                    <td colSpan={3} className={`${td} text-center py-6 text-muted`}>queued — waiting for nodes to check in...</td>
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
    </div>
  )
}
