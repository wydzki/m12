import { useEffect, useRef, useState } from 'react'
import { Radio, Loader2 } from 'lucide-react'
import { StatusBadge } from './ui.jsx'
import { api } from '../api.js'

const td = 'px-4 py-3 border-t border-line align-top'
const th = 'px-4 py-3 text-left text-[13px] font-semibold text-muted'

// Maps a command's lifecycle to a badge the StatusBadge component understands.
const STATUS = { pending: 'scanning', sent: 'running', done: 'success', expired: 'offline', gone: 'offline' }
const LABEL = { pending: 'Queued', sent: 'Running', done: 'Done', expired: 'Expired', gone: 'Gone' }

export default function FleetDiagnostics() {
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [task, setTask] = useState(null) // { taskId, command, nodes:[...] }
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
        setError(r.data?.error || `Failed (${r.status}).`)
        return
      }
      // seed an empty task; the poll fills in node results
      setTask({ taskId: r.data.taskId, command: cmd, nodes: [] })
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const done = task ? task.nodes.filter((n) => n.status === 'done').length : 0

  return (
    <div className="space-y-4 max-w-4xl">
      <section className="card p-4">
        <h2 className="font-bold text-[18px] flex items-center gap-2">
          <Radio className="size-5 text-accent" /> Fleet Diagnostics
        </h2>
        <p className="text-muted text-[13px] mt-0.5">
          Run one command across every reporting node. Each runs it on its next mTLS check-in.
        </p>
        <form onSubmit={broadcast} className="mt-3 flex items-center gap-2">
          <span className="font-mono text-muted">$</span>
          <input
            className="field font-mono flex-1"
            placeholder="e.g. uptime"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" disabled={busy} className="pill pill-accent flex items-center gap-2 disabled:opacity-60 whitespace-nowrap">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
            Broadcast to All Nodes
          </button>
        </form>
        {error && <p className="text-bad text-[13px] mt-2">{error}</p>}
      </section>

      {task && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3">
            <h3 className="font-bold text-[15px]">
              Results — <span className="font-mono">{task.command}</span>
            </h3>
            <span className="text-muted text-[13px]">
              {done}/{task.nodes.length} responded
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr>
                  <th className={th}>Node ID</th>
                  <th className={th}>Status</th>
                  <th className={th}>Output</th>
                </tr>
              </thead>
              <tbody>
                {task.nodes.length === 0 && (
                  <tr>
                    <td colSpan={3} className={`${td} text-center py-8 text-muted`}>Queued — waiting for nodes to check in…</td>
                  </tr>
                )}
                {task.nodes.map((n) => (
                  <tr key={n.nodeId} className="hover:bg-soft transition-colors">
                    <td className={`${td} font-mono text-[13px] font-semibold whitespace-nowrap`}>{n.nodeId}</td>
                    <td className={td}>
                      <StatusBadge status={STATUS[n.status] || 'offline'} />
                      <span className="sr-only">{LABEL[n.status]}</span>
                      {n.status === 'done' && n.exitCode !== null && (
                        <span className="text-muted text-[12px] ml-2">exit {n.exitCode}</span>
                      )}
                    </td>
                    <td className={td}>
                      {n.output != null ? (
                        <pre className="font-mono text-[12.5px] whitespace-pre-wrap break-words max-h-40 overflow-auto bg-ink text-[#e6e6e6] rounded p-2">
                          {n.output || '(no output)'}
                        </pre>
                      ) : (
                        <span className="text-muted text-[13px]">—</span>
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
