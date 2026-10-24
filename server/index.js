import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHash, verifyPassword, safeEqual, SessionStore, RateLimiter } from './security.js'
import { loadStatic, serveStatic } from './static.js'
import { buildDashboard, MAX_NODES, DEFAULT_NODES } from './mockData.js'
import { TelemetryStore } from './telemetryStore.js'
import { createIngestServer } from './ingest.js'
import { createBuildHandler, CROSS_RE } from './build.js'
import { ExecStore } from './execStore.js'

// ---------- config ----------

function fail(msg) {
  console.error(`[m12] config error: ${msg}`)
  process.exit(1)
}

const env = process.env
const config = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8080),
  user: env.M12_USER || fail('M12_USER is not set'),
  hash: (() => {
    try {
      return parseHash(env.M12_PASSWORD_HASH || fail('M12_PASSWORD_HASH is not set (run: npm run hash-password)'))
    } catch (e) {
      return fail(e.message)
    }
  })(),
  tlsCert: env.TLS_CERT_FILE,
  tlsKey: env.TLS_KEY_FILE,
  trustProxy: env.TRUST_PROXY === '1',
  publicOrigin: env.PUBLIC_ORIGIN || null, // e.g. https://m12.example.com
  nodeCount: Math.max(1, Math.min(MAX_NODES, Number(env.M12_NODE_COUNT || DEFAULT_NODES) || DEFAULT_NODES)),
  // mTLS telemetry ingest listener
  ingestHost: env.INGEST_HOST || '0.0.0.0',
  ingestPort: Number(env.INGEST_PORT || 8443),
  ingestCa: env.INGEST_CA_FILE,
  ingestCert: env.INGEST_CERT_FILE,
  ingestKey: env.INGEST_KEY_FILE,
  ingestRevoked: env.INGEST_REVOKED_FILE || null,
  offlineAfterMin: Math.max(1, Number(env.NODE_OFFLINE_AFTER_MIN || 10) || 10),
  demo: env.M12_DEMO !== '0', // show sample fleet until real nodes report; set M12_DEMO=0 to disable
  // Remote command execution on nodes (diagnostics). OFF unless explicitly enabled.
  execEnabled: (env.M12_EXEC_ENABLED || '').trim() === '1',
  // Optional: comma-separated exact commands that may be queued. Empty = any command.
  execAllowlist: (env.M12_EXEC_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Build endpoint (compiles the MIPS agent). Off unless explicitly enabled.
  buildEnabled: (env.M12_BUILD_ENABLED || '').trim() === '1',
  buildCross: env.M12_BUILD_CROSS || 'mips-linux-gnu-',
  buildDest: env.M12_BUILD_DEST || '/srv/tftp/m12-agent',
  buildToken: env.M12_BUILD_TOKEN || null,
  buildTimeoutMs: Math.max(30_000, (Number(env.M12_BUILD_TIMEOUT_SEC) || 600) * 1000),
}

if (config.buildEnabled && !CROSS_RE.test(config.buildCross)) fail('M12_BUILD_CROSS contains invalid characters')

const ingestFiles = [config.ingestCa, config.ingestCert, config.ingestKey].filter(Boolean).length
if (ingestFiles > 0 && ingestFiles < 3) fail('ingest needs INGEST_CA_FILE, INGEST_CERT_FILE and INGEST_KEY_FILE set together')
if (!Number.isInteger(config.ingestPort) || config.ingestPort < 1 || config.ingestPort > 65535) fail('INGEST_PORT is invalid')

const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host)
const tls = Boolean(config.tlsCert && config.tlsKey)
// cookies are Secure unless we're plain-HTTP on loopback (local dev, or behind a TLS proxy on the same box)
const secureCookie = tls || env.COOKIE_SECURE !== '0'

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail('PORT is invalid')
if (!isLoopback && !tls) fail(`refusing to serve plain HTTP on ${config.host}. Bind to 127.0.0.1 behind a TLS proxy, or set TLS_CERT_FILE and TLS_KEY_FILE.`)
if (config.trustProxy && !isLoopback) fail('TRUST_PROXY=1 is only safe when HOST is loopback (otherwise X-Forwarded-For can be spoofed)')
if (!secureCookie && !isLoopback) fail('COOKIE_SECURE=0 is only allowed on loopback')

const COOKIE = secureCookie ? '__Host-m12_sid' : 'm12_sid'
const SESSION_MAX_AGE = 12 * 60 * 60 // seconds

const telemetry = new TelemetryStore({ offlineAfterMs: config.offlineAfterMin * 60_000 })
const sessions = new SessionStore({ idleMs: 30 * 60_000, absoluteMs: SESSION_MAX_AGE * 1000, max: 50 })
const ipLimiter = new RateLimiter({ limit: 5, windowMs: 15 * 60_000 }) // failed logins per IP
const globalLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 }) // all login attempts, caps scrypt CPU use

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
let files
try {
  files = loadStatic(DIST)
} catch (e) {
  fail(e.message)
}

// ---------- helpers ----------

const log = (...args) => console.log(new Date().toISOString(), ...args)

const execStore = config.execEnabled ? new ExecStore({ allowlist: new Set(config.execAllowlist), log }) : null

function securityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
      "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
}

function json(res, status, body, extra = {}) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...extra,
  })
  res.end(data)
}

function clientIp(req) {
  if (config.trustProxy) {
    // rightmost entry is the one our own proxy appended; anything left of it is client-controlled
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
    const last = xff[xff.length - 1]
    if (last && net.isIP(last)) return last
  }
  return req.socket.remoteAddress || 'unknown'
}

function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`
}

// CSRF defence on state-changing requests (on top of SameSite=Strict)
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin') return false
  const origin = req.headers.origin
  if (!origin) return site === 'same-origin' // browsers always send one of the two
  if (config.publicOrigin) return origin === config.publicOrigin
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function readJson(req, res, limit = 4096) {
  const tooLarge = () => {
    res.setHeader('Connection', 'close') // drop the rest of the body with the socket
    return Object.assign(new Error('too large'), { status: 413 })
  }
  if (Number(req.headers['content-length']) > limit) return Promise.reject(tooLarge())
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.pause()
        reject(tooLarge())
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

function requireSession(req, res) {
  const s = sessions.get(getCookie(req, COOKIE))
  if (!s) json(res, 401, { error: 'Not signed in.' })
  return s
}

// ---------- routes ----------

async function login(req, res) {
  const ip = clientIp(req)
  const wait = ipLimiter.blockedFor(ip) || globalLimiter.blockedFor('all')
  if (wait) return json(res, 429, { error: 'Too many attempts. Try again later.', retryAfter: wait }, { 'Retry-After': String(wait) })
  globalLimiter.hit('all')

  const body = await readJson(req, res)
  const { username, password } = body ?? {}
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 128 || password.length > 256) {
    return json(res, 400, { error: 'Bad request.' })
  }

  // always run scrypt so a wrong username takes as long as a wrong password
  const userOk = safeEqual(username, config.user)
  const passOk = await verifyPassword(password, config.hash)
  if (!userOk || !passOk) {
    ipLimiter.hit(ip)
    log(`login failed ip=${ip}`)
    return json(res, 401, { error: 'Wrong username or password.' })
  }

  ipLimiter.reset(ip)
  sessions.destroy(getCookie(req, COOKIE)) // never reuse a pre-login session id
  const sid = sessions.create(config.user)
  log(`login ok ip=${ip}`)
  json(res, 200, { user: config.user }, { 'Set-Cookie': sessionCookie(sid, SESSION_MAX_AGE) })
}

function logout(req, res) {
  sessions.destroy(getCookie(req, COOKIE))
  json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) })
}

const routes = {
  'POST /api/login': login,
  'POST /api/logout': logout,
  'GET /api/session': (req, res) => {
    const s = requireSession(req, res)
    if (s) json(res, 200, { user: s.user })
  },
  'GET /api/dashboard': (req, res) => {
    if (requireSession(req, res)) json(res, 200, buildDashboard(config.nodeCount, telemetry.list(), config.demo))
  },
  'GET /api/features': (req, res) => {
    if (requireSession(req, res)) json(res, 200, { build: config.buildEnabled, exec: config.execEnabled })
  },
}

const NODE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/

// Remote-diagnostics endpoints (admin side), registered only when enabled.
// POST /api/nodes/:id/exec  -> queue a command for that node
// GET  /api/nodes/:id/exec  -> command history + output for the terminal view
async function execRoute(req, res, nodeId) {
  const s = requireSession(req, res)
  if (!s) return
  if (!NODE_ID_RE.test(nodeId)) return json(res, 400, { error: 'Invalid node id.' })

  if (req.method === 'GET') {
    return json(res, 200, { node: nodeId, commands: execStore.list(nodeId) })
  }
  // POST
  const body = await readJson(req, res)
  const command = body?.command
  if (typeof command !== 'string' || !command.trim() || command.length > 4096) {
    return json(res, 400, { error: 'command must be a non-empty string (max 4096 chars).' })
  }
  if (!execStore.isAllowed(command)) {
    return json(res, 403, { error: 'Command not in the allowlist (M12_EXEC_ALLOWLIST).' })
  }
  const entry = execStore.queue(nodeId, command, s.user)
  json(res, 202, { id: entry.id, status: entry.status })
}

// Fleet broadcast: queue one command for every node that has reported telemetry.
async function fleetExecRoute(req, res) {
  const s = requireSession(req, res)
  if (!s) return
  const body = await readJson(req, res)
  const command = body?.command
  if (typeof command !== 'string' || !command.trim() || command.length > 4096) {
    return json(res, 400, { error: 'command must be a non-empty string (max 4096 chars).' })
  }
  if (!execStore.isAllowed(command)) {
    return json(res, 403, { error: 'Command not in the allowlist (M12_EXEC_ALLOWLIST).' })
  }
  const nodeIds = telemetry.list().map((n) => n.id)
  if (nodeIds.length === 0) return json(res, 409, { error: 'No nodes have reported yet.' })
  const { taskId, count } = execStore.broadcast(nodeIds, command, s.user)
  json(res, 202, { taskId, count })
}

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
function fleetTaskRoute(req, res, taskId) {
  if (!requireSession(req, res)) return
  if (!TASK_ID_RE.test(taskId)) return json(res, 400, { error: 'Invalid task id.' })
  const task = execStore.getTask(taskId)
  if (!task) return json(res, 404, { error: 'Unknown task.' })
  json(res, 200, task)
}

// Compiler endpoint, registered only when explicitly enabled.
if (config.buildEnabled) {
  const buildHandler = createBuildHandler({
    clientDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client'),
    cross: config.buildCross,
    dest: config.buildDest,
    token: config.buildToken,
    timeoutMs: config.buildTimeoutMs,
    log,
  })
  routes['POST /api/build'] = (req, res) => {
    const s = requireSession(req, res)
    if (s) buildHandler(req, res, s)
  }
}

async function handleApi(req, res, pathname) {
  // POSTs are CSRF-checked and must be JSON (applies to dynamic routes too).
  const postGuard = () => {
    if (req.method !== 'POST') return true
    if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden.' }), false
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(res, 415, { error: 'Expected JSON.' }), false
    }
    return true
  }

  // Dynamic exec routes (only when exec is enabled)
  if (pathname.startsWith('/api/nodes/') || pathname.startsWith('/api/fleet/')) {
    if (!execStore) return json(res, 404, { error: 'Not found.' })

    const execMatch = pathname.match(/^\/api\/nodes\/([^/]+)\/exec$/)
    if (execMatch) {
      if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
      if (!postGuard()) return
      return execRoute(req, res, decodeURIComponent(execMatch[1]))
    }
    if (pathname === '/api/fleet/exec') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
      if (!postGuard()) return
      return fleetExecRoute(req, res)
    }
    const taskMatch = pathname.match(/^\/api\/fleet\/exec\/([^/]+)$/)
    if (taskMatch) {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
      return fleetTaskRoute(req, res, decodeURIComponent(taskMatch[1]))
    }
    return json(res, 404, { error: 'Not found.' })
  }

  const route = routes[`${req.method} ${pathname}`]
  if (!route) return json(res, 404, { error: 'Not found.' })
  if (!postGuard()) return
  await route(req, res)
}

async function handle(req, res) {
  securityHeaders(res)
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    res.writeHead(400)
    return res.end()
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      return res.end()
    }
    serveStatic(files, req, res, url.pathname)
  } catch (err) {
    if (!err.status) log('error', err)
    if (!res.headersSent) json(res, err.status || 500, { error: err.status === 413 ? 'Request too large.' : err.status ? 'Bad request.' : 'Internal error.' })
    else res.destroy()
  }
}

// ---------- start ----------

const options = { maxHeaderSize: 8192 }
const server = tls
  ? https.createServer({ ...options, cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey), minVersion: 'TLSv1.2' }, handle)
  : http.createServer(options, handle)

// slow-client protection
server.headersTimeout = 10_000
server.requestTimeout = 15_000
server.keepAliveTimeout = 5_000
server.maxRequestsPerSocket = 200

server.listen(config.port, config.host, () => {
  log(`m12 listening on ${tls ? 'https' : 'http'}://${config.host}:${config.port}`)
  log(`features: exec=${config.execEnabled} build=${config.buildEnabled} demo=${config.demo}`)
})

// mTLS telemetry ingest listener (only authorized nodes can reach application code)
if (ingestFiles === 3) {
  let ingest
  try {
    ingest = createIngestServer({
      ca: readFileSync(config.ingestCa),
      cert: readFileSync(config.ingestCert),
      key: readFileSync(config.ingestKey),
      store: telemetry,
      execStore,
      revokedFile: config.ingestRevoked,
      log,
    })
  } catch (e) {
    fail(`could not start ingest listener: ${e.message}`)
  }
  ingest.on('error', (e) => log('ingest server error', e.message))
  ingest.listen(config.ingestPort, config.ingestHost, () => {
    log(`m12 ingest (mTLS) listening on https://${config.ingestHost}:${config.ingestPort}`)
  })
} else {
  log('ingest listener disabled (set INGEST_CA_FILE, INGEST_CERT_FILE, INGEST_KEY_FILE to enable)')
}
