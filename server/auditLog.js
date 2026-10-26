// Append-only audit log for every dispatch (command, file op, shell).
// In-memory ring buffer + optional JSONL file for persistence across restarts.
import crypto from 'node:crypto'
import fs from 'node:fs'

export class AuditLog {
  constructor({ maxEntries = 10000, file = null, log = console.log } = {}) {
    this.entries = []
    this.maxEntries = maxEntries
    this.file = file
    this.log = log
    this.fd = null
    if (this.file) {
      try {
        this.fd = fs.openSync(this.file, 'a')
      } catch (e) {
        this.log(`audit: could not open ${this.file}: ${e.message}`)
      }
    }
  }

  record({ operator, selector, targets, commandType, command, taskId }) {
    const entry = {
      id: crypto.randomBytes(6).toString('base64url'),
      ts: Date.now(),
      operator,
      selector: typeof selector === 'string' ? selector : JSON.stringify(selector),
      targets,
      targetCount: targets.length,
      commandType,
      command: typeof command === 'string' ? command.slice(0, 500) : null,
      taskId: taskId ?? null,
      completedAt: null,
      durationMs: null,
    }
    this.entries.push(entry)
    while (this.entries.length > this.maxEntries) this.entries.shift()
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, JSON.stringify(entry) + '\n')
      } catch { /* best effort */ }
    }
    this.log(`audit id=${entry.id} type=${commandType} by=${operator} targets=${entry.targetCount}`)
    return entry
  }

  complete(taskId) {
    const entry = this.entries.find((e) => e.taskId === taskId && !e.completedAt)
    if (!entry) return
    entry.completedAt = Date.now()
    entry.durationMs = entry.completedAt - entry.ts
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, JSON.stringify({ _update: entry.id, completedAt: entry.completedAt, durationMs: entry.durationMs }) + '\n')
      } catch { /* best effort */ }
    }
  }

  list(limit = 200) {
    return this.entries.slice(-limit).reverse()
  }
}
