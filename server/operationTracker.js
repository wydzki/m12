// Deadman switch for long-running operations (shells, file transfers).
//
// Every active operation requires periodic heartbeats from the operator session.
// A server-side sweeper marks stale operations as orphaned and dispatches stop
// opcodes to the agents. A short grace window allows operator reconnect.
import crypto from 'node:crypto'

export class OperationTracker {
  constructor({ heartbeatTtlMs = 60_000, graceMs = 30_000, sweepIntervalMs = 10_000, log = console.log } = {}) {
    this.heartbeatTtlMs = heartbeatTtlMs
    this.graceMs = graceMs
    this.log = log
    this.ops = new Map() // opId -> operation record
    this.maxOps = 2000
    this.timer = setInterval(() => this.sweep(), sweepIntervalMs)
    this.timer.unref()
    this._onOrphan = null // callback: (op) => void — set by the wiring code
  }

  onOrphan(fn) {
    this._onOrphan = fn
  }

  // Register a new operation. Returns the operation record.
  register({ operator, commandType, selector, targets, taskId }) {
    const id = crypto.randomBytes(9).toString('base64url')
    const now = Date.now()
    const op = {
      id,
      operator,
      commandType,
      selector: typeof selector === 'string' ? selector : JSON.stringify(selector),
      targets: [...targets],
      taskId: taskId ?? null,
      createdAt: now,
      lastHeartbeat: now,
      status: 'active', // active | orphaned | closed
      closedAt: null,
      closeReason: null,
    }
    if (this.ops.size >= this.maxOps) {
      for (const [k, v] of this.ops) {
        if (v.status === 'closed') { this.ops.delete(k); break }
      }
      if (this.ops.size >= this.maxOps) this.ops.delete(this.ops.keys().next().value)
    }
    this.ops.set(id, op)
    this.log(`op register id=${id} type=${commandType} by=${operator} targets=${targets.length}`)
    return op
  }

  // Operator heartbeat — cheap, no side effects.
  heartbeat(opId) {
    const op = this.ops.get(opId)
    if (!op) return null
    if (op.status === 'closed') return null
    // Reconnect within grace window: revive from orphaned back to active
    if (op.status === 'orphaned') {
      this.log(`op revived id=${opId} by=${op.operator}`)
    }
    op.status = 'active'
    op.lastHeartbeat = Date.now()
    return op
  }

  // Operator explicitly closes an operation (normal teardown).
  close(opId, reason = 'operator_closed') {
    const op = this.ops.get(opId)
    if (!op || op.status === 'closed') return null
    op.status = 'closed'
    op.closedAt = Date.now()
    op.closeReason = reason
    this.log(`op closed id=${opId} reason=${reason}`)
    return op
  }

  get(opId) {
    return this.ops.get(opId) ?? null
  }

  // List active/orphaned operations for an operator (or all if no filter).
  list(operator) {
    const out = []
    for (const op of this.ops.values()) {
      if (op.status === 'closed') continue
      if (operator && op.operator !== operator) continue
      out.push(op)
    }
    return out
  }

  // Sweeper: runs every sweepIntervalMs.
  sweep() {
    const now = Date.now()
    for (const op of this.ops.values()) {
      if (op.status === 'closed') continue
      const age = now - op.lastHeartbeat
      if (op.status === 'active' && age > this.heartbeatTtlMs) {
        op.status = 'orphaned'
        this.log(`op orphaned id=${op.id} type=${op.commandType} by=${op.operator} stale=${Math.round(age / 1000)}s`)
      }
      if (op.status === 'orphaned' && age > this.heartbeatTtlMs + this.graceMs) {
        op.status = 'closed'
        op.closedAt = now
        op.closeReason = 'operator_session_expired'
        this.log(`op expired id=${op.id} type=${op.commandType} by=${op.operator} targets=${op.targets.length}`)
        if (this._onOrphan) {
          try { this._onOrphan(op) } catch (e) { this.log(`op orphan callback error: ${e.message}`) }
        }
      }
    }
    // Prune old closed ops (keep for 5 minutes for status queries)
    for (const [k, op] of this.ops) {
      if (op.status === 'closed' && op.closedAt && now - op.closedAt > 5 * 60_000) {
        this.ops.delete(k)
      }
    }
  }

  destroy() {
    clearInterval(this.timer)
  }
}
