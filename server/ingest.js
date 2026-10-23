// mTLS telemetry ingest listener.
//
// Nodes connect over TLS and must present a client certificate signed by our
// private CA. `requestCert + rejectUnauthorized` make Node reject the TLS
// handshake for anyone whose cert isn't CA-signed, so unauthorized traffic
// never reaches application code — which is what makes binding to a public
// interface safe. The node's identity is the certificate CN, taken from the
// verified cert, never from the request body.
import https from 'node:https'
import fs from 'node:fs'
import { RateLimiter } from './security.js'

// CN must look like a node id: lowercase, starts alnum, "node-" style. Never hex-only,
// so it can't collide with a serial in the revocation file.
const CN_RE = /^[a-z][a-z0-9-]{1,63}$/
const STATUS = new Set(['healthy', 'scanning', 'offline'])

function validateTelemetry(b) {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return null
  const out = {}
  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !STATUS.has(b.status)) return null
    out.status = b.status
  }
  if (b.region !== undefined) {
    if (typeof b.region !== 'string' || b.region.length > 40) return null
    out.region = b.region
  }
  if (b.metrics !== undefined) {
    const m = b.metrics
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return null
    const keys = Object.keys(m)
    if (keys.length > 20) return null
    const clean = {}
    for (const k of keys) {
      if (k.length > 24) return null
      const v = m[k]
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
      clean[k] = v
    }
    out.metrics = clean
  }
  return out
}

// Revocation list, hot-reloaded when the file changes. One entry per line:
// a node CN, or a certificate serial (hex, colons optional). '#' starts a comment.
class RevocationList {
  constructor(file) {
    this.file = file
    this.mtime = -1
    this.cns = new Set()
    this.serials = new Set()
  }
  reload() {
    if (!this.file) return
    let st
    try {
      st = fs.statSync(this.file)
    } catch {
      this.cns.clear()
      this.serials.clear()
      this.mtime = -1
      return
    }
    if (st.mtimeMs === this.mtime) return
    this.mtime = st.mtimeMs
    const cns = new Set()
    const serials = new Set()
    for (let line of fs.readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      const bare = line.replace(/:/g, '')
      if (/^[0-9A-Fa-f]+$/.test(bare) && bare.length >= 4) serials.add(bare.toUpperCase())
      else cns.add(line)
    }
    this.cns = cns
    this.serials = serials
  }
  isRevoked(cn, serial) {
    this.reload()
    if (this.cns.has(cn)) return true
    if (serial && this.serials.has(serial.replace(/:/g, '').toUpperCase())) return true
    return false
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.pause() // stop reading; handler sends 413 and closes the connection
        reject(Object.assign(new Error('too large'), { status: 413 }))
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// Output a node posts back for a command it ran. id/output/exitCode only.
function validateOutput(b) {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return null
  if (typeof b.id !== 'string' || b.id.length > 32 || !/^[A-Za-z0-9_-]+$/.test(b.id)) return null
  if (typeof b.output !== 'string') return null
  const exitCode = b.exitCode === undefined || b.exitCode === null ? null : b.exitCode
  if (exitCode !== null && !Number.isInteger(exitCode)) return null
  return { id: b.id, output: b.output, exitCode }
}

export function createIngestServer({ ca, cert, key, store, execStore = null, revokedFile, log = console.log, bodyLimit = 4096, perNodePerMin = 120 }) {
  const limiter = new RateLimiter({ limit: perNodePerMin, windowMs: 60_000, maxKeys: 20_000 })
  const revoked = new RevocationList(revokedFile)

  const server = https.createServer(
    {
      ca,
      cert,
      key,
      requestCert: true,
      rejectUnauthorized: true, // reject any client without a CA-signed cert at the TLS layer
      minVersion: 'TLSv1.2',
      maxHeaderSize: 8192,
      honorCipherOrder: true,
    },
    async (req, res) => {
      const send = (status, obj) => {
        const d = JSON.stringify(obj)
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(d), 'Cache-Control': 'no-store' })
        res.end(d)
      }
      try {
        // Defence in depth: TLS already enforced this, but never trust an unverified peer.
        if (!req.client.authorized) return send(401, { error: 'client certificate required' })
        const peer = req.socket.getPeerCertificate()
        const cn = peer?.subject?.CN
        if (!cn || !CN_RE.test(cn)) return send(403, { error: 'certificate CN is not a valid node id' })
        if (revoked.isRevoked(cn, peer.serialNumber)) {
          log(`ingest revoked cn=${cn} serial=${peer.serialNumber}`)
          return send(403, { error: 'certificate revoked' })
        }

        if (req.method !== 'POST') return send(404, { error: 'not found' })
        const path = req.url
        if (path !== '/ingest' && !(execStore && path === '/output')) return send(404, { error: 'not found' })

        const wait = limiter.blockedFor(cn)
        if (wait) {
          res.setHeader('Retry-After', String(wait))
          return send(429, { error: 'rate limit exceeded', retryAfter: wait })
        }
        limiter.hit(cn)

        // command output can be larger than a telemetry check-in
        const limit = path === '/output' ? 128 * 1024 : bodyLimit
        let body
        try {
          body = await readBody(req, limit)
        } catch (e) {
          if (e.status === 413) {
            res.setHeader('Connection', 'close')
            return send(413, { error: 'payload too large' })
          }
          return send(400, { error: 'invalid JSON' })
        }

        if (path === '/output') {
          const out = validateOutput(body)
          if (!out) return send(422, { error: 'invalid output' })
          // A node can only answer command ids queued for its own cert CN.
          const ok = execStore.recordOutput(cn, out.id, out.output, out.exitCode)
          return send(ok ? 200 : 404, ok ? { ok: true } : { error: 'unknown command id for this node' })
        }

        const telemetry = validateTelemetry(body)
        if (!telemetry) return send(422, { error: 'invalid telemetry' })

        store.record(cn, telemetry, req.socket.remoteAddress)
        // Deliver any commands queued for this node (it will run them and POST /output).
        const commands = execStore ? execStore.takePending(cn) : []
        send(200, { ok: true, node: cn, commands })
      } catch (err) {
        log('ingest error', err?.message || err)
        if (!res.headersSent) send(500, { error: 'internal error' })
        else res.destroy()
      }
    },
  )

  // Drop clients whose cert fails verification without logging a stack per attempt.
  server.on('tlsClientError', () => {})
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.keepAliveTimeout = 5_000
  server.maxRequestsPerSocket = 500

  return server
}

export { validateTelemetry }
