// Mock fleet data, served only to logged-in sessions via /api/dashboard.
// Scales from a handful of nodes up to MAX_NODES. Replace buildDashboard()
// with real node telemetry later.

const MIN = 60_000

export const MAX_NODES = 1000
export const DEFAULT_NODES = 1000

// Seeded RNG so the fleet looks the same on every reload
function rng(seed) {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

function series(seed, base, amp, n = 24, round = 1) {
  const r = rng(seed)
  let v = base
  return Array.from({ length: n }, (_, i) => {
    v += (r() - 0.5) * amp
    v = Math.max(base - amp * 2, Math.min(base + amp * 2, v))
    return { i, v: Number(v.toFixed(round)) }
  })
}

function trafficSeries(seed, n, label) {
  const inb = rng(seed)
  const out = rng(seed + 7)
  return Array.from({ length: n }, (_, i) => {
    const wave = Math.sin((i / n) * Math.PI * 2) * 0.35 + 1
    return {
      t: label(i),
      inbound: Math.round((180 + inb() * 120) * wave),
      outbound: Math.round((70 + out() * 60) * wave),
    }
  })
}

const pad = (n) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const REGIONS = ['LAN-East', 'LAN-Core', 'LAN-West', 'DMZ', 'LAN-North', 'LAN-South']

// /22 holds 1016 usable hosts (192.168.8.1 .. 192.168.11.254), enough for MAX_NODES.
const SUBNET = '192.168.8.0/22'
const ipForHost = (i) => `192.168.${8 + Math.floor((i - 1) / 254)}.${((i - 1) % 254) + 1}`

function makeNodes(count, now) {
  const r = rng(1337)
  const width = Math.max(2, String(count).length) // 2-digit ids for small fleets, wider for big ones
  const nodes = []
  for (let i = 1; i <= count; i++) {
    const roll = r()
    let status = 'healthy'
    if (roll > 0.95) status = 'offline'
    else if (roll > 0.85) status = 'scanning'
    const lastSeen = status === 'offline' ? now - (30 + Math.floor(r() * 600)) * MIN : now - Math.floor(r() * 10 * MIN)
    nodes.push({
      id: `node-mips-${String(i).padStart(width, '0')}`,
      ip: ipForHost(i),
      region: REGIONS[i % REGIONS.length],
      status,
      lastSeen,
    })
  }
  return nodes
}

// Curated demo feed, used only when no real nodes have reported yet.
function mockActivity(nodes, online, minsAgo) {
  const pick = (status, i) => {
    const arr = nodes.filter((n) => n.status === status)
    return arr.length ? arr[i % arr.length] : nodes[i % nodes.length]
  }
  let no = 4512318
  const ev = (mins, kind, text) => ({ no: no--, at: minsAgo(mins), kind, text })
  const b = pick('healthy', 1)
  const s1 = pick('scanning', 0)
  const events = [
    ev(0.3, 'auth', `Node ${pick('healthy', 0).ip} authenticated.`),
    ev(1, 'deploy', `Payload telemetry-agent@2.4.1 deployed to ${b.id}.`),
    ev(2, 'scan', `Port scan started on ${s1.ip} (${s1.id}).`),
    ev(4, 'auth', `Node ${pick('healthy', 2).ip} authenticated.`),
    ev(12, 'warn', 'Latency spike on LAN-West: 38ms (threshold 25ms).'),
    ev(18, 'fail', `Deployment dep-0139 to ${pick('offline', 0).id} failed: host unreachable.`),
    ev(47, 'offline', `${pick('offline', 1).id} (${pick('offline', 1).ip}) stopped responding.`),
    ev(95, 'deploy', `Config bundle cfg-2026.10.22 rolled out to ${online} nodes.`),
    ev(185, 'offline', `${pick('offline', 2).id} marked offline.`),
  ]
  const deployments = [
    { id: 'dep-0142', payload: 'telemetry-agent', version: '2.4.1', target: b.id, status: 'success', by: 'zki', at: minsAgo(1), duration: '14s' },
    { id: 'dep-0141', payload: 'telemetry-agent', version: '2.4.1', target: pick('healthy', 3).id, status: 'success', by: 'zki', at: minsAgo(7), duration: '22s' },
    { id: 'dep-0140', payload: 'scanner-core', version: '0.9.3', target: s1.id, status: 'running', by: 'm12d', at: minsAgo(9), duration: '—' },
    { id: 'dep-0139', payload: 'telemetry-agent', version: '2.4.1', target: pick('offline', 0).id, status: 'failed', by: 'zki', at: minsAgo(18), duration: '30s' },
    { id: 'dep-0138', payload: 'cfg-2026.10.22', version: 'bundle', target: `${online} nodes`, status: 'success', by: 'm12d', at: minsAgo(95), duration: '1m 48s' },
    { id: 'dep-0137', payload: 'scanner-core', version: '0.9.2', target: pick('scanning', 1).id, status: 'success', by: 'm12d', at: minsAgo(240), duration: '19s' },
  ]
  return { events, deployments }
}

// Activity derived from real check-ins, newest first.
function liveActivity(nodes) {
  let no = Date.now()
  return [...nodes]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 14)
    .map((n) => {
      const kind = n.status === 'offline' ? 'offline' : n.status === 'scanning' ? 'scan' : 'auth'
      const text =
        n.status === 'offline'
          ? `${n.id} (${n.ip}) stopped checking in.`
          : n.status === 'scanning'
            ? `${n.id} reported a scan in progress from ${n.ip}.`
            : `${n.id} checked in from ${n.ip}.`
      return { no: no--, at: n.lastSeen, kind, text }
    })
}

// Flat zero series for the "no nodes yet" state.
const flat = (n = 24) => Array.from({ length: n }, (_, i) => ({ i, v: 0 }))

function emptyDashboard(now) {
  const metrics = [
    { key: 'instances', label: 'Active Instances', value: '0', unit: 'nodes', note: '>waiting for first check-in', tone: 'good', spark: flat() },
    { key: 'latency', label: 'Network Latency', value: '—', unit: 'ms p50', note: '>no data yet', tone: 'good', spark: flat() },
    { key: 'deploys', label: 'Deployment Status', value: '—', unit: '', note: '>no deploys yet', tone: 'good', spark: flat() },
    { key: 'errors', label: 'Error Rate', value: '0', unit: '%', note: '>no nodes reporting', tone: 'good', spark: flat() },
  ]
  const zero = (n, label) => Array.from({ length: n }, (_, i) => ({ t: label(i), inbound: 0, outbound: 0 }))
  const traffic = {
    '1h': zero(12, (i) => `-${55 - i * 5}m`),
    '24h': zero(24, (i) => `${pad(i)}:00`),
    '7d': zero(7, (i) => DAYS[(new Date(now).getDay() + i + 1) % 7]),
  }
  return { subnet: '—', live: false, demo: false, total: 0, nodes: [], events: [], deployments: [], metrics, traffic }
}

// Derive latency from node-reported metrics (the agent can send { metrics: { latency: <ms> } }).
function liveLatency(nodes) {
  const vals = nodes.filter((n) => n.status !== 'offline' && n.metrics?.latency != null).map((n) => n.metrics.latency)
  if (vals.length === 0) return null
  vals.sort((a, b) => a - b)
  return vals[Math.floor(vals.length * 0.5)]
}

// count: size of the demo fleet when no live data. liveNodes: real telemetry
// (from the mTLS ingest store) which, when present, becomes the fleet.
// demo: when false and no nodes have reported, show an empty dashboard instead
// of the sample fleet.
export function buildDashboard(count = DEFAULT_NODES, liveNodes = null, demo = true) {
  const now = Date.now()
  const minsAgo = (m) => now - m * MIN
  const live = Array.isArray(liveNodes) && liveNodes.length > 0

  if (!live && !demo) return emptyDashboard(now)

  const nodes = live ? liveNodes.slice(0, MAX_NODES) : makeNodes(Math.max(1, Math.min(MAX_NODES, count | 0)), now)
  const total = nodes.length
  const offlineCount = nodes.filter((n) => n.status === 'offline').length
  const scanningCount = nodes.filter((n) => n.status === 'scanning').length
  const online = total - offlineCount

  const { events, deployments } = live ? { events: liveActivity(nodes), deployments: [] } : mockActivity(nodes, online, minsAgo)

  const errorRate = ((offlineCount / total) * 100).toFixed(1)

  if (live) {
    const p50 = liveLatency(nodes)
    const latVal = p50 != null ? p50.toFixed(1) : '—'
    const latUnit = p50 != null ? 'ms p50' : ''
    const latNote = p50 != null ? `>from ${nodes.filter((n) => n.metrics?.latency != null).length} reporting nodes` : '>agent not reporting latency'
    const flatSpark = Array.from({ length: 24 }, (_, i) => ({ i, v: 0 }))
    const metrics = [
      { key: 'instances', label: 'Active Nodes', value: `${online}`, unit: `/ ${total}`, note: `>${scanningCount} scanning now`, tone: 'good', spark: flatSpark },
      { key: 'latency', label: 'Network Latency', value: latVal, unit: latUnit, note: latNote, tone: 'good', spark: flatSpark },
      { key: 'deploys', label: 'Deployment Status', value: '—', unit: '', note: '>deployments land here', tone: 'good', spark: flatSpark },
      { key: 'errors', label: 'Error Rate', value: errorRate, unit: '%', note: `>${offlineCount} nodes unreachable`, tone: offlineCount ? 'bad' : 'good', spark: flatSpark },
    ]
    const checkins = nodes.filter((n) => n.status !== 'offline').length
    const zeroTraffic = (n, label) => Array.from({ length: n }, (_, i) => ({ t: label(i), inbound: checkins, outbound: 0 }))
    const traffic = {
      '1h': zeroTraffic(12, (i) => `-${55 - i * 5}m`),
      '24h': zeroTraffic(24, (i) => `${pad(i)}:00`),
      '7d': zeroTraffic(7, (i) => DAYS[(new Date(now).getDay() + i + 1) % 7]),
    }
    return { subnet: 'live', live: true, demo: false, total, nodes, events, deployments, metrics, traffic }
  }

  const metrics = [
    { key: 'instances', label: 'Active Instances', value: `${online}`, unit: `/ ${total}`, note: `>${scanningCount} scanning now`, tone: 'good', spark: series(11, online, Math.max(1, online * 0.05), 24, 0) },
    { key: 'latency', label: 'Network Latency', value: '4.2', unit: 'ms p50', note: '>-0.6ms vs 1h ago', tone: 'good', spark: series(23, 4.5, 1.4) },
    { key: 'deploys', label: 'Deployment Status', value: '92', unit: '% success', note: '>11 of 12 succeeded today', tone: 'good', spark: series(37, 92, 4, 24, 0) },
    { key: 'errors', label: 'Error Rate', value: errorRate, unit: '%', note: `>${offlineCount} nodes unreachable`, tone: offlineCount ? 'bad' : 'good', spark: series(41, Number(errorRate) || 0.5, 0.5, 24, 2) },
  ]

  const traffic = {
    '1h': trafficSeries(101, 12, (i) => `-${55 - i * 5}m`),
    '24h': trafficSeries(202, 24, (i) => `${pad(i)}:00`),
    '7d': trafficSeries(303, 7, (i) => DAYS[(new Date(now).getDay() + i + 1) % 7]),
  }

  return { subnet: SUBNET, live: false, demo: true, total, nodes, events, deployments, metrics, traffic }
}
