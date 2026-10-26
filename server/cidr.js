// IPv4 CIDR allowlist. Parses "10.0.0.0/8,192.168.1.0/24" into fast bitmask
// checks. When enabled, every dispatch target IP must fall within at least one
// allowed range — a safety net against operator error broadcasting commands
// into networks you don't own.

function parseCIDR(raw) {
  const s = raw.trim()
  const slash = s.indexOf('/')
  const ip = slash >= 0 ? s.slice(0, slash) : s
  const bits = slash >= 0 ? Number(s.slice(slash + 1)) : 32
  if (bits < 0 || bits > 32 || !Number.isInteger(bits)) return null
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (v < 0 || v > 255 || !Number.isInteger(v)) return null
    n = (n << 8) | v
  }
  n = n >>> 0
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return { network: (n & mask) >>> 0, mask, cidr: s }
}

function ipToU32(ip) {
  const v4 = ip.replace(/^::ffff:/, '')
  const parts = v4.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (v < 0 || v > 255 || !Number.isInteger(v)) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

export class CIDRAllowlist {
  constructor(cidrs, log = console.log) {
    this.ranges = []
    for (const raw of cidrs) {
      const r = parseCIDR(raw)
      if (!r) { log(`cidr: ignoring invalid CIDR "${raw}"`); continue }
      this.ranges.push(r)
    }
    this.enabled = this.ranges.length > 0
  }

  contains(ip) {
    if (!this.enabled) return true
    const n = ipToU32(ip)
    if (n === null) return false
    for (const r of this.ranges) {
      if (((n & r.mask) >>> 0) === r.network) return true
    }
    return false
  }

  // Returns list of { id, ip } entries that fall OUTSIDE the allowlist.
  reject(targets) {
    if (!this.enabled) return []
    return targets.filter((t) => !this.contains(t.ip))
  }
}
