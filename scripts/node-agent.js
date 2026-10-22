// Reference telemetry agent — the program a MIPS node runs to report in.
// One shot per run (cron / systemd timer friendly). Presents the node's client
// certificate over mTLS; the server derives the node id from the cert CN, so
// nothing here can impersonate another node.
//
//   M12_INGEST_URL=https://m12.example.com:8443 \
//   M12_NODE_CA=/etc/m12/ca.crt \
//   M12_NODE_CERT=/etc/m12/node-mips-0007.crt \
//   M12_NODE_KEY=/etc/m12/node-mips-0007.key \
//   node node-agent.js [status]
//
// status is one of healthy|scanning|offline (default healthy). Exit code is 0
// on HTTP 200, non-zero otherwise, so a supervisor can alert on failures.
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'

const env = process.env
const url = new URL(env.M12_INGEST_URL || 'https://127.0.0.1:8443')
const status = process.argv[2] || 'healthy'

const read = (p, name) => {
  if (!p) {
    console.error(`${name} is not set`)
    process.exit(2)
  }
  return fs.readFileSync(p)
}

// Example payload. Replace the metrics with whatever the node actually measures.
const load = os.loadavg()[0]
const body = JSON.stringify({
  status,
  region: env.M12_NODE_REGION || 'LAN',
  metrics: {
    cpu: Number((load * 100).toFixed(1)),
    memPct: Number((((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1)),
    uptimeH: Number((os.uptime() / 3600).toFixed(1)),
  },
})

const req = https.request(
  {
    host: url.hostname,
    port: url.port || 8443,
    path: '/ingest',
    method: 'POST',
    ca: read(env.M12_NODE_CA, 'M12_NODE_CA'),
    cert: read(env.M12_NODE_CERT, 'M12_NODE_CERT'),
    key: read(env.M12_NODE_KEY, 'M12_NODE_KEY'),
    minVersion: 'TLSv1.2',
    servername: url.hostname, // SNI + server-cert hostname check
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10_000,
  },
  (res) => {
    let data = ''
    res.on('data', (c) => (data += c))
    res.on('end', () => {
      console.log(`${res.statusCode} ${data}`)
      process.exit(res.statusCode === 200 ? 0 : 1)
    })
  },
)

req.on('error', (e) => {
  console.error(`ingest failed: ${e.message}`)
  process.exit(1)
})
req.on('timeout', () => req.destroy(new Error('timeout')))
req.end(body)
