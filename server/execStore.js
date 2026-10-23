// Remote-command queue for node diagnostics. In memory, bounded, no persistence.
// Shared between the dashboard API (admin queues commands, reads results) and the
// mTLS ingest listener (nodes pull pending commands, post output back).
//
// SECURITY: this is remote code execution on the fleet. The admin queues a command
// for a node id; the node only ever receives commands addressed to the id in its
// client certificate (enforced in ingest.js), and can only post output for its own
// entries. An optional allowlist restricts what may be queued at all.
import crypto from 'node:crypto'

export class ExecStore {
  constructor({ maxPerNode = 100, maxNodes = 2000, maxOutputBytes = 64 * 1024, allowlist = null, log = console.log } = {}) {
    this.maxPerNode = maxPerNode
    this.maxNodes = maxNodes
    this.maxOutputBytes = maxOutputBytes
    // allowlist: null = any command allowed; otherwise a Set of exact commands.
    this.allowlist = allowlist && allowlist.size ? allowlist : null
    this.log = log
    this.map = new Map() // nodeId -> [ {id, command, status, queuedAt, sentAt, finishedAt, output, exitCode, by, taskId} ]
    this.tasks = new Map() // taskId -> { command, by, at, targets: [{nodeId, id}] }
    this.maxTasks = 200
  }

  isAllowed(command) {
    return !this.allowlist || this.allowlist.has(command.trim())
  }

  queue(nodeId, command, by = 'admin', taskId = null) {
    const id = crypto.randomBytes(9).toString('base64url')
    const entry = { id, command, status: 'pending', queuedAt: Date.now(), sentAt: null, finishedAt: null, output: null, exitCode: null, by, taskId }
    let list = this.map.get(nodeId)
    if (!list) {
      if (this.map.size >= this.maxNodes) this.map.delete(this.map.keys().next().value)
      list = []
      this.map.set(nodeId, list)
    }
    list.push(entry)
    // drop oldest finished entries past the cap
    while (list.length > this.maxPerNode) {
      const i = list.findIndex((e) => e.status === 'done' || e.status === 'expired')
      list.splice(i === -1 ? 0 : i, 1)
    }
    this.log(`exec queue node=${nodeId} id=${id} by=${by} cmd=${JSON.stringify(command).slice(0, 200)}`)
    return entry
  }

  // Node pulls its pending commands (called from the mTLS handler). Marks them sent
  // so they aren't delivered twice.
  takePending(nodeId) {
    const list = this.map.get(nodeId)
    if (!list) return []
    const now = Date.now()
    const out = []
    for (const e of list) {
      if (e.status === 'pending') {
        e.status = 'sent'
        e.sentAt = now
        out.push({ id: e.id, cmd: e.command })
      }
    }
    return out
  }

  recordOutput(nodeId, id, output, exitCode) {
    const list = this.map.get(nodeId)
    if (!list) return false
    const e = list.find((x) => x.id === id)
    if (!e) return false // node can only answer its own queued ids
    e.output = String(output ?? '').slice(0, this.maxOutputBytes)
    e.exitCode = Number.isInteger(exitCode) ? exitCode : null
    e.status = 'done'
    e.finishedAt = Date.now()
    this.log(`exec output node=${nodeId} id=${id} exit=${e.exitCode} bytes=${e.output.length}`)
    return true
  }

  list(nodeId) {
    return (this.map.get(nodeId) || []).slice().reverse() // newest first
  }

  // Queue one command for many nodes and record the group as a task.
  broadcast(nodeIds, command, by = 'admin') {
    const taskId = crypto.randomBytes(9).toString('base64url')
    const targets = []
    for (const nodeId of nodeIds) {
      const entry = this.queue(nodeId, command, by, taskId)
      targets.push({ nodeId, id: entry.id })
    }
    if (this.tasks.size >= this.maxTasks) this.tasks.delete(this.tasks.keys().next().value)
    this.tasks.set(taskId, { command, by, at: Date.now(), targets })
    this.log(`exec broadcast task=${taskId} nodes=${targets.length} by=${by} cmd=${JSON.stringify(command).slice(0, 200)}`)
    return { taskId, count: targets.length }
  }

  getTask(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return null
    const nodes = task.targets.map(({ nodeId, id }) => {
      const e = (this.map.get(nodeId) || []).find((x) => x.id === id)
      return { nodeId, status: e ? e.status : 'gone', exitCode: e ? e.exitCode : null, output: e ? e.output : null }
    })
    return { taskId, command: task.command, by: task.by, at: task.at, nodes }
  }
}
