import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)

// ---------- password hashing (scrypt) ----------

const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LEN = 32

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(password, salt, KEY_LEN, PARAMS)
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export function parseHash(str) {
  const parts = String(str || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error('M12_PASSWORD_HASH is not a valid scrypt hash')
  const [N, r, p] = parts.slice(1, 4).map(Number)
  const salt = Buffer.from(parts[4], 'base64')
  const key = Buffer.from(parts[5], 'base64')
  if (![N, r, p].every(Number.isInteger) || salt.length < 16 || key.length !== KEY_LEN) {
    throw new Error('M12_PASSWORD_HASH is malformed')
  }
  return { N, r, p, salt, key }
}

export async function verifyPassword(password, parsed) {
  const { N, r, p, salt, key } = parsed
  const candidate = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: PARAMS.maxmem })
  return crypto.timingSafeEqual(candidate, key)
}

// constant-time string compare (hash first so lengths always match)
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// ---------- sessions (in memory, server side) ----------

const SID_RE = /^[A-Za-z0-9_-]{43}$/
const digest = (sid) => crypto.createHash('sha256').update(sid).digest('base64')

export class SessionStore {
  constructor({ idleMs, absoluteMs, max }) {
    Object.assign(this, { idleMs, absoluteMs, max })
    this.map = new Map() // sha256(sid) -> { user, created, seen }
    setInterval(() => this.prune(), 60_000).unref()
  }

  create(user) {
    this.prune()
    while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value) // evict oldest
    const sid = crypto.randomBytes(32).toString('base64url')
    const now = Date.now()
    this.map.set(digest(sid), { user, created: now, seen: now })
    return sid
  }

  get(sid) {
    if (!sid || !SID_RE.test(sid)) return null
    const key = digest(sid)
    const s = this.map.get(key)
    if (!s) return null
    const now = Date.now()
    if (now - s.seen > this.idleMs || now - s.created > this.absoluteMs) {
      this.map.delete(key)
      return null
    }
    s.seen = now
    return s
  }

  destroy(sid) {
    if (sid && SID_RE.test(sid)) this.map.delete(digest(sid))
  }

  prune() {
    const now = Date.now()
    for (const [k, s] of this.map) {
      if (now - s.seen > this.idleMs || now - s.created > this.absoluteMs) this.map.delete(k)
    }
  }
}

// ---------- fixed-window rate limiter ----------

export class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 10_000 }) {
    Object.assign(this, { limit, windowMs, maxKeys })
    this.map = new Map() // key -> { count, resetAt }
    setInterval(() => this.prune(), 60_000).unref()
  }

  entry(key) {
    const now = Date.now()
    let e = this.map.get(key)
    if (!e || e.resetAt <= now) {
      if (!e && this.map.size >= this.maxKeys) {
        this.prune()
        while (this.map.size >= this.maxKeys) this.map.delete(this.map.keys().next().value)
      }
      e = { count: 0, resetAt: now + this.windowMs }
      this.map.set(key, e)
    }
    return e
  }

  // seconds until the key may try again, or 0 if allowed
  blockedFor(key) {
    const e = this.entry(key)
    return e.count >= this.limit ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0
  }

  hit(key) {
    this.entry(key).count++
  }

  reset(key) {
    this.map.delete(key)
  }

  prune() {
    const now = Date.now()
    for (const [k, e] of this.map) if (e.resetAt <= now) this.map.delete(k)
  }
}
