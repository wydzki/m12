import crypto from 'node:crypto'

export class FileStore {
  constructor({ maxFiles = 500, maxFileSize = 4 * 1024 * 1024, maxTotalBytes = 128 * 1024 * 1024, log = console.log } = {}) {
    this.maxFiles = maxFiles
    this.maxFileSize = maxFileSize
    this.maxTotalBytes = maxTotalBytes
    this.log = log
    this.map = new Map()
    this.totalBytes = 0
  }

  store(data, destPath, by = 'admin') {
    if (data.length > this.maxFileSize) return null
    while (this.totalBytes + data.length > this.maxTotalBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value
      this._remove(oldest)
    }
    if (this.map.size >= this.maxFiles) {
      const oldest = this.map.keys().next().value
      this._remove(oldest)
    }
    const id = crypto.randomBytes(12).toString('base64url')
    const sha256 = crypto.createHash('sha256').update(data).digest('hex')
    const entry = { id, data, destPath, sha256, size: data.length, by, createdAt: Date.now(), pulls: new Map() }
    this.map.set(id, entry)
    this.totalBytes += data.length
    this.log(`file store id=${id} path=${destPath} size=${data.length} sha256=${sha256.slice(0, 16)}..`)
    return { id, sha256, size: data.length }
  }

  get(id) {
    return this.map.get(id) || null
  }

  storePull(nodeId, remotePath, by = 'admin') {
    const id = crypto.randomBytes(12).toString('base64url')
    const entry = { id, nodeId, remotePath, by, createdAt: Date.now(), data: null, sha256: null, size: null, done: false }
    this.map.set(id, entry)
    this.log(`file pull queued id=${id} node=${nodeId} path=${remotePath}`)
    return { id }
  }

  receivePull(id, data) {
    const entry = this.map.get(id)
    if (!entry || entry.done) return false
    if (data.length > this.maxFileSize) return false
    entry.data = data
    entry.sha256 = crypto.createHash('sha256').update(data).digest('hex')
    entry.size = data.length
    entry.done = true
    this.totalBytes += data.length
    while (this.totalBytes > this.maxTotalBytes && this.map.size > 1) {
      for (const [k, v] of this.map) {
        if (k !== id) { this._remove(k); break }
      }
    }
    this.log(`file pull received id=${id} size=${data.length} sha256=${entry.sha256.slice(0, 16)}..`)
    return true
  }

  getStatus(id) {
    const e = this.map.get(id)
    if (!e) return null
    return { id: e.id, destPath: e.destPath, remotePath: e.remotePath, sha256: e.sha256, size: e.size, done: e.done ?? true, createdAt: e.createdAt, by: e.by }
  }

  _remove(id) {
    const e = this.map.get(id)
    if (!e) return
    if (e.data) this.totalBytes -= e.data.length
    this.map.delete(id)
  }

  remove(id) {
    this._remove(id)
  }
}
