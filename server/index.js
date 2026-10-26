import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import crypto from 'node:crypto'
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
import { FileStore } from './fileStore.js'
import { CIDRAllowlist } from './cidr.js'
import { AuditLog } from './auditLog.js'
import { OperationTracker } from './operationTracker.js'

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
  ingestTicketKey: env.INGEST_TICKET_KEY_FILE || null,
  offlineAfterMin: Math.max(1, Number(env.NODE_OFFLINE_AFTER_MIN || 10) || 10),
  demo: env.M12_DEMO !== '0', // show sample fleet until real nodes report; set M12_DEMO=0 to disable
  // Remote command execution on nodes (diagnostics). OFF unless explicitly enabled.
  execEnabled: (env.M12_EXEC_ENABLED || '').trim() === '1',
  // Optional: comma-separated exact commands that may be queued. Empty = any command.
  execAllowlist: (env.M12_EXEC_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),

  // CIDR allowlist: comma-separated IPv4 CIDRs. When set, every dispatch target
  // must fall within at least one range or the request is rejected.
  cidrAllowlist: (env.M12_CIDR_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Audit log file (JSONL). Omit or empty to log to memory only.
  auditFile: env.M12_AUDIT_FILE || null,

  // Confirmation gate: fleet operations above this target count require operator confirmation.
  confirmThreshold: Math.max(1, Number(env.M12_CONFIRM_THRESHOLD || 50) || 50),
  // Command types that always require confirmation regardless of target count.
  dangerousVerbs: new Set((env.M12_DANGEROUS_VERBS || 'file_push,file_pull,shell_broadcast,config_update').split(',').map((s) => s.trim()).filter(Boolean)),

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
const fileStore = config.execEnabled ? new FileStore({ log }) : null
const cidr = new CIDRAllowlist(config.cidrAllowlist, log)
const audit = new AuditLog({ file: config.auditFile, log })
const opTracker = config.execEnabled ? new OperationTracker({ log }) : null

if (opTracker) {
  const STOP_OPCODES = { exec: '__m12_shell_close', file_push: '__m12_file_abort', file_pull: '__m12_file_abort' }
  opTracker.onOrphan((op) => {
    const opcode = STOP_OPCODES[op.commandType] || '__m12_shell_close'
    const stopCmd = JSON.stringify({ __m12: opcode, operationId: op.id })
    let stopped = 0
    for (const nodeId of op.targets) {
      if (execStore) { execStore.queue(nodeId, stopCmd, 'system'); stopped++ }
    }
    audit.record({
      operator: op.operator,
      selector: op.selector,
      targets: op.targets,
      commandType: op.commandType,
      command: `[orphan] operation_id=${op.id} reason=${op.closeReason} agents_stopped=${stopped}`,
      taskId: op.taskId,
    })
    log(`op orphan dispatch id=${op.id} opcode=${opcode} agents_stopped=${stopped}`)
  })
}

// Confirmation tokens: single-use, 60s TTL, bound to selector+commandType+count.
const confirmTokens = new Map()
const CONFIRM_TTL = 60_000
const CONFIRM_MAX = 500

function createConfirmToken(selector, commandType, count, user) {
  if (confirmTokens.size >= CONFIRM_MAX) {
    for (const [k, v] of confirmTokens) {
      if (Date.now() - v.createdAt > CONFIRM_TTL) confirmTokens.delete(k)
    }
    if (confirmTokens.size >= CONFIRM_MAX) confirmTokens.delete(confirmTokens.keys().next().value)
  }
  const token = crypto.randomBytes(24).toString('base64url')
  confirmTokens.set(token, {
    selector: JSON.stringify(selector),
    commandType,
    count,
    user,
    createdAt: Date.now(),
    used: false,
  })
  return token
}

function validateConfirmToken(token, commandType, currentCount, res) {
  if (!token || typeof token !== 'string') {
    json(res, 403, { error: 'confirm_token required for fleet dispatch.' })
    return false
  }
  const entry = confirmTokens.get(token)
  if (!entry) {
    json(res, 403, { error: 'Invalid or expired confirm token.' })
    return false
  }
  if (entry.used) {
    confirmTokens.delete(token)
    json(res, 403, { error: 'Confirm token already used.' })
    return false
  }
  if (Date.now() - entry.createdAt > CONFIRM_TTL) {
    confirmTokens.delete(token)
    json(res, 403, { error: 'Confirm token expired (60s). Re-run dry-run.' })
    return false
  }
  if (entry.commandType !== commandType) {
    json(res, 403, { error: `Token is for ${entry.commandType}, not ${commandType}.` })
    return false
  }
  if (entry.count !== currentCount) {
    confirmTokens.delete(token)
    json(res, 409, { error: 'Fleet size changed since dry-run.', expected: entry.count, actual: currentCount })
    return false
  }
  entry.used = true
  return true
}

function requiresConfirmation(selector, commandType, count) {
  if (selector === 'all') return true
  if (config.dangerousVerbs.has(commandType)) return true
  if (count >= config.confirmThreshold) return true
  return false
}

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
    if (requireSession(req, res)) json(res, 200, {
      build: config.buildEnabled,
      exec: config.execEnabled,
      cidr: cidr.enabled,
      protoVersions: CMD_MIN_VERSION,
      confirmThreshold: config.confirmThreshold,
      dangerousVerbs: [...config.dangerousVerbs],
    })
  },
  'GET /api/audit': (req, res) => {
    if (requireSession(req, res)) json(res, 200, { entries: audit.list() })
  },
}

const NODE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/
const TAG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const TAG_VAL_RE = /^.{0,64}$/

async function tagRoute(req, res, nodeId) {
  const s = requireSession(req, res)
  if (!s) return
  if (!NODE_ID_RE.test(nodeId)) return json(res, 400, { error: 'Invalid client id.' })
  if (!telemetry.has(nodeId)) return json(res, 404, { error: 'Unknown client.' })

  if (req.method === 'GET') {
    return json(res, 200, { node: nodeId, tags: telemetry.getTags(nodeId) })
  }

  // PUT — set tags (merge)
  if (req.method === 'PUT') {
    const body = await readJson(req, res)
    const tags = body?.tags
    if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
      return json(res, 400, { error: 'tags must be an object of {key: value} pairs.' })
    }
    const keys = Object.keys(tags)
    if (keys.length === 0 || keys.length > 20) return json(res, 400, { error: 'Provide 1-20 tags.' })
    for (const k of keys) {
      if (!TAG_KEY_RE.test(k)) return json(res, 400, { error: `Invalid tag key: ${k}` })
      if (typeof tags[k] !== 'string' || !TAG_VAL_RE.test(tags[k])) return json(res, 400, { error: `Invalid tag value for ${k}` })
    }
    for (const [k, v] of Object.entries(tags)) telemetry.setTag(nodeId, k, v)
    log(`tags set node=${nodeId} keys=${keys.join(',')} by=${s.user}`)
    return json(res, 200, { node: nodeId, tags: telemetry.getTags(nodeId) })
  }

  // DELETE — remove a tag by key
  if (req.method === 'DELETE') {
    const body = await readJson(req, res)
    const key = body?.key
    if (typeof key !== 'string' || !TAG_KEY_RE.test(key)) return json(res, 400, { error: 'Invalid tag key.' })
    telemetry.deleteTag(nodeId, key)
    log(`tag deleted node=${nodeId} key=${key} by=${s.user}`)
    return json(res, 200, { node: nodeId, tags: telemetry.getTags(nodeId) })
  }

  return json(res, 405, { error: 'Method not allowed.' })
}

// Remote-diagnostics endpoints (admin side), registered only when enabled.
// POST /api/nodes/:id/exec  -> queue a command for that node
// GET  /api/nodes/:id/exec  -> command history + output for the terminal view
async function execRoute(req, res, nodeId) {
  const s = requireSession(req, res)
  if (!s) return
  if (!NODE_ID_RE.test(nodeId)) return json(res, 400, { error: 'Invalid client id.' })

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
  if (!enforceAllowlist([nodeId], res)) return
  const { eligible, skipped } = enforceVersion([nodeId], 'exec')
  if (eligible.length === 0) {
    return json(res, 409, { error: `Agent ${nodeId} is protocol v${skipped[0].version}, command requires v${skipped[0].required}.`, skipped })
  }
  const entry = execStore.queue(nodeId, command, s.user)
  audit.record({ operator: s.user, selector: [nodeId], targets: [nodeId], commandType: 'exec', command, taskId: null })
  const op = opTracker?.register({ operator: s.user, commandType: 'exec', selector: [nodeId], targets: [nodeId] })
  json(res, 202, { id: entry.id, status: entry.status, operationId: op?.id })
}

function validateSelector(sel) {
  if (sel === undefined || sel === null || sel === 'all') return 'all'
  if (Array.isArray(sel)) {
    if (sel.length === 0 || sel.length > 500) return null
    for (const id of sel) {
      if (typeof id !== 'string' || !NODE_ID_RE.test(id)) return null
    }
    return sel
  }
  if (typeof sel === 'object' && !Array.isArray(sel)) {
    const allowed = new Set(['status', 'arch', 'region', 'hostname', 'tags'])
    for (const k of Object.keys(sel)) {
      if (!allowed.has(k)) return null
      if (k === 'tags') {
        if (typeof sel.tags !== 'object' || sel.tags === null || Array.isArray(sel.tags)) return null
        const tkeys = Object.keys(sel.tags)
        if (tkeys.length === 0 || tkeys.length > 20) return null
        for (const tk of tkeys) {
          if (typeof tk !== 'string' || tk.length === 0 || tk.length > 64) return null
          if (typeof sel.tags[tk] !== 'string' || sel.tags[tk].length > 64) return null
        }
      } else {
        if (typeof sel[k] !== 'string' || sel[k].length > 64 || sel[k].length === 0) return null
      }
    }
    if (Object.keys(sel).length === 0) return null
    return sel
  }
  return null
}

const CMD_MIN_VERSION = { exec: 0, file_push: 1, file_pull: 1, config_update: 2 }

function enforceVersion(nodeIds, commandType) {
  const minV = CMD_MIN_VERSION[commandType] ?? 0
  if (minV === 0) return { eligible: nodeIds, skipped: [] }
  const eligible = []
  const skipped = []
  for (const id of nodeIds) {
    const v = telemetry.get(id)?.protoVersion ?? 0
    if (v >= minV) eligible.push(id)
    else skipped.push({ id, version: v, required: minV })
  }
  return { eligible, skipped }
}

function enforceAllowlist(nodeIds, res) {
  if (!cidr.enabled) return true
  const targets = nodeIds.map((id) => ({ id, ip: telemetry.get(id)?.ip })).filter((t) => t.ip)
  const rejected = cidr.reject(targets)
  if (rejected.length > 0) {
    json(res, 403, {
      error: `${rejected.length} target(s) outside CIDR allowlist.`,
      rejected: rejected.map((r) => ({ id: r.id, ip: r.ip })),
    })
    return false
  }
  return true
}

// Dry-run: resolves the selector through the full pipeline (CIDR + version) and
// returns the count + a single-use confirm token. No side effects.
async function fleetDryRunRoute(req, res) {
  const s = requireSession(req, res)
  if (!s) return
  const body = await readJson(req, res)
  const { commandType } = body ?? {}
  if (!commandType || typeof commandType !== 'string') {
    return json(res, 400, { error: 'commandType is required (exec, file_push, file_pull, config_update).' })
  }
  const selector = validateSelector(body?.selector)
  if (selector === null) {
    return json(res, 400, { error: 'Invalid selector.' })
  }
  const nodeIds = telemetry.resolve(selector)
  if (nodeIds.length === 0) return json(res, 409, { error: 'No clients match the selector.' })

  // Run through CIDR without sending a response on failure — we need to report, not block
  let cidrRejected = []
  if (cidr.enabled) {
    const targets = nodeIds.map((id) => ({ id, ip: telemetry.get(id)?.ip })).filter((t) => t.ip)
    cidrRejected = cidr.reject(targets)
  }
  const afterCidr = cidrRejected.length > 0
    ? nodeIds.filter((id) => !cidrRejected.some((r) => r.id === id))
    : nodeIds
  if (afterCidr.length === 0) {
    return json(res, 403, { error: 'All targets outside CIDR allowlist.', cidrRejected: cidrRejected.map((r) => ({ id: r.id, ip: r.ip })) })
  }

  const { eligible, skipped } = enforceVersion(afterCidr, commandType)
  if (eligible.length === 0) {
    return json(res, 409, { error: 'All matched clients are below the required protocol version.', skipped })
  }

  const confirm = requiresConfirmation(selector, commandType, eligible.length)
  const token = createConfirmToken(selector, commandType, eligible.length, s.user)
  json(res, 200, {
    count: eligible.length,
    selector,
    commandType,
    confirmRequired: confirm,
    confirm_token: token,
    skipped: skipped.length > 0 ? skipped : undefined,
    cidrRejected: cidrRejected.length > 0 ? cidrRejected.map((r) => ({ id: r.id, ip: r.ip })) : undefined,
  })
}

// Fleet command dispatch with subset selector.
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
  const selector = validateSelector(body?.selector)
  if (selector === null) {
    return json(res, 400, { error: 'Invalid selector. Use "all", an array of node IDs, or {status, arch, region, hostname}.' })
  }
  const nodeIds = telemetry.resolve(selector)
  if (nodeIds.length === 0) return json(res, 409, { error: 'No clients match the selector.' })
  if (!enforceAllowlist(nodeIds, res)) return
  const { eligible, skipped } = enforceVersion(nodeIds, 'exec')
  if (eligible.length === 0) return json(res, 409, { error: 'All matched clients are below the required protocol version.', skipped })
  if (!validateConfirmToken(body?.confirm_token, 'exec', eligible.length, res)) return
  const { taskId, count } = execStore.broadcast(eligible, command, s.user)
  audit.record({ operator: s.user, selector, targets: eligible, commandType: 'exec', command, taskId })
  const op = opTracker?.register({ operator: s.user, commandType: 'exec', selector, targets: eligible, taskId })
  json(res, 202, { taskId, count, selector, operationId: op?.id, skipped: skipped.length > 0 ? skipped : undefined })
}

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
function fleetTaskRoute(req, res, taskId) {
  if (!requireSession(req, res)) return
  if (!TASK_ID_RE.test(taskId)) return json(res, 400, { error: 'Invalid task id.' })
  const task = execStore.getTask(taskId)
  if (!task) return json(res, 404, { error: 'Unknown task.' })
  json(res, 200, task)
}

const FILE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/

async function filePushRoute(req, res) {
  const s = requireSession(req, res)
  if (!s) return
  const body = await readJson(req, res, 6 * 1024 * 1024)
  const { path: destPath, data: b64data, selector: rawSel } = body ?? {}
  if (typeof destPath !== 'string' || !destPath.trim() || destPath.length > 512) {
    return json(res, 400, { error: 'path must be a non-empty string (max 512 chars).' })
  }
  if (typeof b64data !== 'string' || !b64data.length) {
    return json(res, 400, { error: 'data must be a base64-encoded string.' })
  }
  let buf
  try {
    buf = Buffer.from(b64data, 'base64')
    if (buf.length === 0) throw new Error()
  } catch {
    return json(res, 400, { error: 'data is not valid base64.' })
  }
  const selector = validateSelector(rawSel)
  if (selector === null) return json(res, 400, { error: 'Invalid selector.' })
  const nodeIds = telemetry.resolve(selector)
  if (nodeIds.length === 0) return json(res, 409, { error: 'No clients match the selector.' })
  if (!enforceAllowlist(nodeIds, res)) return
  const { eligible, skipped } = enforceVersion(nodeIds, 'file_push')
  if (eligible.length === 0) return json(res, 409, { error: 'All matched clients are below the required protocol version for file_push.', skipped })
  if (!validateConfirmToken(body?.confirm_token, 'file_push', eligible.length, res)) return
  const stored = fileStore.store(buf, destPath, s.user)
  if (!stored) return json(res, 413, { error: 'File too large (max 4 MB).' })
  const cmd = JSON.stringify({ __m12: 'file_push', fileId: stored.id, path: destPath, size: stored.size, sha256: stored.sha256 })
  const { taskId, count } = execStore.broadcast(eligible, cmd, s.user)
  audit.record({ operator: s.user, selector, targets: eligible, commandType: 'file_push', command: destPath, taskId })
  const op = opTracker?.register({ operator: s.user, commandType: 'file_push', selector, targets: eligible, taskId })
  json(res, 202, { taskId, fileId: stored.id, count, sha256: stored.sha256, size: stored.size, operationId: op?.id, skipped: skipped.length > 0 ? skipped : undefined })
}

async function filePullRoute(req, res) {
  const s = requireSession(req, res)
  if (!s) return
  const body = await readJson(req, res)
  const { path: remotePath, selector: rawSel } = body ?? {}
  if (typeof remotePath !== 'string' || !remotePath.trim() || remotePath.length > 512) {
    return json(res, 400, { error: 'path must be a non-empty string (max 512 chars).' })
  }
  const selector = validateSelector(rawSel)
  if (selector === null) return json(res, 400, { error: 'Invalid selector.' })
  const nodeIds = telemetry.resolve(selector)
  if (nodeIds.length === 0) return json(res, 409, { error: 'No clients match the selector.' })
  if (!enforceAllowlist(nodeIds, res)) return
  const { eligible, skipped } = enforceVersion(nodeIds, 'file_pull')
  if (eligible.length === 0) return json(res, 409, { error: 'All matched clients are below the required protocol version for file_pull.', skipped })
  if (!validateConfirmToken(body?.confirm_token, 'file_pull', eligible.length, res)) return
  const results = []
  for (const nodeId of eligible) {
    const { id: fileId } = fileStore.storePull(nodeId, remotePath, s.user)
    const cmd = JSON.stringify({ __m12: 'file_pull', fileId, path: remotePath })
    execStore.queue(nodeId, cmd, s.user)
    results.push({ nodeId, fileId })
  }
  audit.record({ operator: s.user, selector, targets: eligible, commandType: 'file_pull', command: remotePath })
  const op = opTracker?.register({ operator: s.user, commandType: 'file_pull', selector, targets: eligible })
  json(res, 202, { count: results.length, pulls: results, operationId: op?.id, skipped: skipped.length > 0 ? skipped : undefined })
}

const ADDR_RE = /^[a-zA-Z0-9._-]{1,128}(:[0-9]{1,5})?$/

async function configPushRoute(req, res) {
  const s = requireSession(req, res)
  if (!s) return
  const body = await readJson(req, res)
  const { addresses, selector: rawSel } = body ?? {}
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 8) {
    return json(res, 400, { error: 'addresses must be an array of 1-8 host:port strings.' })
  }
  for (const a of addresses) {
    if (typeof a !== 'string' || !ADDR_RE.test(a)) return json(res, 400, { error: `Invalid address: ${a}` })
  }
  const selector = validateSelector(rawSel)
  if (selector === null) return json(res, 400, { error: 'Invalid selector.' })
  const nodeIds = telemetry.resolve(selector)
  if (nodeIds.length === 0) return json(res, 409, { error: 'No clients match the selector.' })
  if (!enforceAllowlist(nodeIds, res)) return
  const { eligible, skipped } = enforceVersion(nodeIds, 'config_update')
  if (eligible.length === 0) return json(res, 409, { error: 'All matched clients are below the required protocol version for config_update (v2).', skipped })
  if (!validateConfirmToken(body?.confirm_token, 'config_update', eligible.length, res)) return
  const addrStr = addresses.join(',')
  const cmd = JSON.stringify({ __m12: 'config_update', addresses: addrStr })
  const { taskId, count } = execStore.broadcast(eligible, cmd, s.user)
  audit.record({ operator: s.user, selector, targets: eligible, commandType: 'config_update', command: `addresses=${addrStr}`, taskId })
  json(res, 202, { taskId, count, addresses, skipped: skipped.length > 0 ? skipped : undefined })
}

function fileDownloadRoute(req, res, fileId) {
  if (!requireSession(req, res)) return
  if (!FILE_ID_RE.test(fileId)) return json(res, 400, { error: 'Invalid file id.' })
  const entry = fileStore.get(fileId)
  if (!entry || !entry.data) return json(res, 404, { error: 'File not found.' })
  const b64 = entry.data.toString('base64')
  json(res, 200, { id: fileId, path: entry.destPath || entry.remotePath, sha256: entry.sha256, size: entry.size, data: b64 })
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

  // Tag CRUD (not gated by exec — tags are registry metadata)
  const tagMatch = pathname.match(/^\/api\/nodes\/([^/]+)\/tags$/)
  if (tagMatch) {
    if (!postGuard()) return
    return tagRoute(req, res, decodeURIComponent(tagMatch[1]))
  }

  // Remove client (not gated by exec)
  if (req.method === 'DELETE' && pathname.startsWith('/api/nodes/')) {
    const match = pathname.match(/^\/api\/nodes\/([^/]+)$/)
    if (!match) return json(res, 404, { error: 'Not found.' })
    if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden.' })
    const s = requireSession(req, res)
    if (!s) return
    const id = decodeURIComponent(match[1])
    if (!NODE_ID_RE.test(id)) return json(res, 400, { error: 'Invalid client id.' })
    const removed = telemetry.remove(id)
    log(`client removed id=${id} by=${s.user}`)
    return json(res, 200, { ok: true, removed })
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
    if (pathname === '/api/fleet/dry-run') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
      if (!postGuard()) return
      return fleetDryRunRoute(req, res)
    }
    if (pathname === '/api/fleet/exec') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
      if (!postGuard()) return
      return fleetExecRoute(req, res)
    }
    if (pathname === '/api/fleet/push') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
      if (!postGuard()) return
      return filePushRoute(req, res)
    }
    if (pathname === '/api/fleet/pull') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
      if (!postGuard()) return
      return filePullRoute(req, res)
    }
    if (pathname === '/api/fleet/config') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
      if (!postGuard()) return
      return configPushRoute(req, res)
    }
    if (pathname === '/api/ops' && req.method === 'GET') {
      const s = requireSession(req, res)
      if (!s) return
      return json(res, 200, { operations: opTracker ? opTracker.list(s.user) : [] })
    }
    const opMatch = pathname.match(/^\/api\/ops\/([A-Za-z0-9_-]{1,32})\/heartbeat$/)
    if (opMatch && req.method === 'POST') {
      if (!postGuard()) return
      const s = requireSession(req, res)
      if (!s) return
      const op = opTracker?.heartbeat(decodeURIComponent(opMatch[1]))
      if (!op) return json(res, 404, { error: 'Unknown or closed operation.' })
      return json(res, 200, { id: op.id, status: op.status })
    }
    const opCloseMatch = pathname.match(/^\/api\/ops\/([A-Za-z0-9_-]{1,32})\/close$/)
    if (opCloseMatch && req.method === 'POST') {
      if (!postGuard()) return
      const s = requireSession(req, res)
      if (!s) return
      const op = opTracker?.close(decodeURIComponent(opCloseMatch[1]), 'operator_closed')
      if (!op) return json(res, 404, { error: 'Unknown or already closed operation.' })
      return json(res, 200, { id: op.id, status: op.status, closedAt: op.closedAt })
    }
    const taskMatch = pathname.match(/^\/api\/fleet\/exec\/([^/]+)$/)
    if (taskMatch) {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
      return fleetTaskRoute(req, res, decodeURIComponent(taskMatch[1]))
    }
    const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/)
    if (fileMatch) {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
      return fileDownloadRoute(req, res, decodeURIComponent(fileMatch[1]))
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
  if (cidr.enabled) log(`cidr allowlist: ${config.cidrAllowlist.join(', ')}`)
  if (config.auditFile) log(`audit log: ${config.auditFile}`)
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
      fileStore,
      revokedFile: config.ingestRevoked,
      ticketKey: config.ingestTicketKey ? readFileSync(config.ingestTicketKey) : null,
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
