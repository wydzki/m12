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

  // Called by the ingest listener. nodeId comes from the client certificate CN,
  // never from the request body, so a node cannot report as another node.
  record(nodeId, data, ip) {
    if (!this.map.has(nodeId) && this.map.size >= this.maxNodes) {
      // evict the stalest node to bound memory under a flood of distinct CNs
      let oldest = null
      let oldestAt = Infinity
      for (const [id, n] of this.map) if (n.lastSeen < oldestAt) ((oldestAt = n.lastSeen), (oldest = id))
      if (oldest) this.map.delete(oldest)
    }
    this.map.set(nodeId, {
      region: data.region ?? 'unknown',
      reportedStatus: data.status ?? 'healthy',
      metrics: data.metrics ?? {},
      ip,
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
        region: n.region,
        status: now - n.lastSeen > this.offlineAfterMs ? 'offline' : n.reportedStatus,
        lastSeen: n.lastSeen,
        metrics: n.metrics,
      }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  }
}
