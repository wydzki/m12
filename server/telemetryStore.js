// In-memory store of the latest telemetry each node reported. Shared between the
// mTLS ingest listener (writer) and the dashboard API (reader). No persistence:
// a restart starts empty and fills as nodes check in again.

const MIN = 60_000

export class TelemetryStore {
  constructor({ offlineAfterMs = 10 * MIN, maxNodes = 5000 } = {}) {
    this.offlineAfterMs = offlineAfterMs
    this.maxNodes = maxNodes
    this.map = new Map() // nodeId -> { region, reportedStatus, metrics, lastSeen, ip }
  }

  // Called by the ingest listener. nodeId is the cert CN (per-node-cert setup)
  // or the device-reported id (fleet mode); see ingest.js for the trust model.
  record(nodeId, data, ip) {
    if (!this.map.has(nodeId) && this.map.size >= this.maxNodes) {
      let oldest = null
      let oldestAt = Infinity
      for (const [id, n] of this.map) if (n.lastSeen < oldestAt) ((oldestAt = n.lastSeen), (oldest = id))
      if (oldest) this.map.delete(oldest)
    }
    const prev = this.map.get(nodeId)
    this.map.set(nodeId, {
      region: data.region ?? 'unknown',
      reportedStatus: data.status ?? 'healthy',
      metrics: data.metrics ?? {},
      ip,
      externalIp: data.externalIp ?? ip,
      user: data.user ?? prev?.user ?? 'root',
      hostname: data.hostname ?? prev?.hostname ?? 'unknown',
      systemType: data.systemType ?? prev?.systemType ?? 'unknown',
      processName: data.processName ?? prev?.processName ?? 'm12-agent',
      connection: 'mTLS',
      heartbeats: (prev?.heartbeats ?? 0) + 1,
      lastSeen: Date.now(),
    })
  }

  has(nodeId) {
    return this.map.has(nodeId)
  }

  get size() {
    return this.map.size
  }

  // Dashboard view. A node that stopped checking in is shown offline regardless
  // of the last status it reported.
  list() {
    const now = Date.now()
    return [...this.map.entries()]
      .map(([id, n]) => ({
        id,
        ip: n.ip,
        externalIp: n.externalIp ?? n.ip,
        region: n.region,
        status: now - n.lastSeen > this.offlineAfterMs ? 'offline' : n.reportedStatus,
        lastSeen: n.lastSeen,
        metrics: n.metrics,
        connection: n.connection ?? 'mTLS',
        user: n.user ?? 'root',
        hostname: n.hostname ?? 'unknown',
        systemType: n.systemType ?? 'unknown',
        processName: n.processName ?? 'm12-agent',
        heartbeats: n.heartbeats ?? 0,
      }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  }
}
