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

function emptyDashboard(now) {
  const metrics = c2Metrics([], false)
  return { subnet: '—', live: false, demo: false, total: 0, nodes: [], events: [], deployments: [], metrics }
}

function c2Metrics(nodes, live) {
  const total = nodes.length
  const offline = nodes.filter((n) => n.status === 'offline').length
  const callbacks = total - offline
  const recent = nodes.filter((n) => n.status !== 'offline' && Date.now() - n.lastSeen < 120_000).length
  return [
    { key: 'sessions', label: 'Active Sessions', value: `${callbacks}`, unit: `/ ${total}`, note: `>${recent} checked in <2m`, tone: 'good' },
    { key: 'shells', label: 'Reverse Shells', value: `${callbacks}`, unit: 'available', note: callbacks ? '>ready for tasking' : '>no agents online', tone: callbacks ? 'good' : 'dim' },
    { key: 'queued', label: 'Broadcast', value: live ? 'ready' : '—', unit: '', note: live ? '>all agents taskable' : '>no agents connected', tone: live ? 'good' : 'dim' },
    { key: 'dead', label: 'Dead Agents', value: `${offline}`, unit: '', note: offline ? `>${offline} not checking in` : '>all agents alive', tone: offline ? 'bad' : 'good' },
  ]
}

export function buildDashboard(count = DEFAULT_NODES, liveNodes = null, demo = true) {
  const now = Date.now()
  const minsAgo = (m) => now - m * MIN
  const live = Array.isArray(liveNodes) && liveNodes.length > 0

  if (!live && !demo) return emptyDashboard(now)

  const nodes = live ? liveNodes.slice(0, MAX_NODES) : makeNodes(Math.max(1, Math.min(MAX_NODES, count | 0)), now)
  const total = nodes.length
  const offlineCount = nodes.filter((n) => n.status === 'offline').length
  const online = total - offlineCount

  const { events, deployments } = live ? { events: liveActivity(nodes), deployments: [] } : mockActivity(nodes, online, minsAgo)
  const metrics = c2Metrics(nodes, live || demo)

  return { subnet: live ? 'live' : SUBNET, live, demo: !live && demo, total, nodes, events, deployments, metrics }
}
