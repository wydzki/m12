# m12

Network analyzer dashboard. React frontend + a dependency-free Node server that
handles login, serves the API, and ingests node telemetry over mutual TLS.

Two listeners, deliberately separate:

| Listener | Bind | Auth | Who connects |
|----------|------|------|--------------|
| Dashboard / API | `127.0.0.1:8080` (behind Caddy TLS) | password + session cookie | you, in a browser |
| Telemetry ingest | `0.0.0.0:8443` | **mutual TLS** (client cert signed by our CA) | your nodes |

The ingest port can face the internet safely: Node is configured with
`requestCert + rejectUnauthorized`, so any client without a certificate signed
by your private CA is dropped during the TLS handshake — no application code
runs for them. A node's identity is the certificate CN, read from the verified
cert, so one node cannot report as another.

## Local development

```sh
npm install
cp .env.example .env        # then fill in M12_USER
npm run hash-password       # paste the printed line into .env
npm run dev:server          # API on 127.0.0.1:8080
npm run dev                 # UI on http://127.0.0.1:5173 (proxies /api)
```

The Vite dev server is for your machine only. Never expose it on the VPS.

## Deploying to a VPS

The Node server refuses to serve plain HTTP on a public interface. Run it on loopback and let Caddy handle HTTPS (automatic Let's Encrypt certs).

1. **Build and configure**

   ```sh
   npm ci && npm run build
   npm run hash-password      # put the line in .env, plus M12_USER and PUBLIC_ORIGIN=https://your.domain
   chmod 600 .env
   ```

2. **Run as an unprivileged service**, `/etc/systemd/system/m12.service`:

   ```ini
   [Unit]
   Description=m12
   After=network.target

   [Service]
   User=m12
   WorkingDirectory=/opt/m12
   ExecStart=/usr/bin/node --env-file=/opt/m12/.env server/index.js
   Restart=on-failure
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   PrivateDevices=true
   ProtectKernelTunables=true
   ProtectKernelModules=true
   ProtectControlGroups=true
   RestrictAddressFamilies=AF_INET AF_INET6
   RestrictNamespaces=true
   LockPersonality=true
   CapabilityBoundingSet=

   [Install]
   WantedBy=multi-user.target
   ```

   ```sh
   sudo useradd --system --no-create-home m12
   sudo chown -R m12:m12 /opt/m12
   sudo systemctl enable --now m12
   ```

3. **HTTPS in front**, `/etc/caddy/Caddyfile`:

   ```
   your.domain {
       reverse_proxy 127.0.0.1:8080
   }
   ```

4. **Firewall**: only SSH, 80 and 443 open.

   ```sh
   sudo ufw default deny incoming
   sudo ufw allow OpenSSH
   sudo ufw allow 80,443/tcp
   sudo ufw enable
   ```

## Node telemetry ingestion (mutual TLS)

Only nodes holding a certificate signed by your private CA can send telemetry.

### 1. Create the CA and the server cert (once, on the VPS)

```sh
./scripts/pki.sh init-ca                      # creates pki/ca.crt + pki/ca.key
./scripts/pki.sh server-cert m12.example.com  # cert for the ingest listener
```

Point the ingest env vars at the output and restart:

```ini
INGEST_HOST=0.0.0.0
INGEST_PORT=8443
INGEST_CA_FILE=/opt/m12/pki/ca.crt
INGEST_CERT_FILE=/opt/m12/pki/server.crt
INGEST_KEY_FILE=/opt/m12/pki/server.key
INGEST_REVOKED_FILE=/opt/m12/pki/revoked.txt
```

Open the port: `sudo ufw allow 8443/tcp`. Keep `pki/ca.key` secret (ideally offline).

### 2. Issue a certificate per node

```sh
./scripts/pki.sh node-cert node-mips-0007
```

Copy three files to the node — `ca.crt`, `node-mips-0007.crt`, `node-mips-0007.key`
— over a trusted channel (the `.key` is that node's identity; never share it between nodes).

### 3. The node reports in

[`scripts/node-agent.js`](scripts/node-agent.js) is a reference agent (run it from cron / a systemd timer):

```sh
M12_INGEST_URL=https://m12.example.com:8443 \
M12_NODE_CA=/etc/m12/ca.crt \
M12_NODE_CERT=/etc/m12/node-mips-0007.crt \
M12_NODE_KEY=/etc/m12/node-mips-0007.key \
node node-agent.js healthy
```

`POST /ingest` body (all fields optional; the node id comes from the cert, not the body):

```json
{ "status": "healthy|scanning|offline", "region": "LAN-East", "metrics": { "cpu": 23, "latencyMs": 4.1 } }
```

Once a node reports, the dashboard switches from demo data to live telemetry (the Fleet panel shows a **LIVE** badge).

### Revoking a compromised node

```sh
./scripts/pki.sh revoke node-mips-0007
```

This appends to `pki/revoked.txt`, which the server re-reads on the next request
— no restart. You can list a node CN or a certificate serial there.

### Ingest hardening

- TLS 1.2+ only; unauthenticated handshakes rejected before any app code.
- Identity = cert CN (validated against `^[a-z][a-z0-9-]{1,63}$`), never the payload.
- Revocation list, hot-reloaded, by CN or serial.
- Per-node rate limit (120 req/min), 4 KB body cap, strict telemetry validation.
- EC P-256 keys — cheap for MIPS devices to handshake.

## Build endpoint (compile the agent from the dashboard)

The **Build Payload** button on the Deployments page compiles the MIPS agent
(`make CROSS=…` in `client/`) and copies the binary to your TFTP directory,
streaming the compiler output live. It is **disabled by default** — a web
endpoint that runs a compiler is opt-in.

Enable it in `.env`:

```ini
M12_BUILD_ENABLED=1
M12_BUILD_CROSS=mips-linux-gnu-     # validated; passed to make as a fixed arg, never via a shell
M12_BUILD_DEST=/srv/tftp/m12-agent
M12_BUILD_TOKEN=<long-random-string>  # optional extra secret (X-M12-Build-Token header)
M12_BUILD_TIMEOUT_SEC=600
```

Requirements on the VPS: the toolchain (`make` + the `mips-linux-gnu-` cross
compiler) must be installed, and the service user must be able to write to
`client/` and to `M12_BUILD_DEST`. Under the hardened systemd unit above that
means adding:

```ini
ReadWritePaths=/opt/m12/client /srv/tftp
```

How it's protected:

- **No shell.** The server runs `spawn('make', ['CROSS=' + cross])` directly —
  no `exec`, no string interpolation — so nothing in a request can be injected
  as a command. `CROSS` comes only from config and is charset-validated at startup.
- **Auth:** requires the logged-in admin session **and** same-origin (CSRF), plus
  the `M12_BUILD_TOKEN` header when configured.
- **One at a time:** a single-flight lock rejects overlapping builds (409).
- **Bounded:** the build is killed (process group) after `M12_BUILD_TIMEOUT_SEC`.
- **Least privilege:** the compiler runs with a minimal env (`PATH`/`HOME`/`LANG`
  only) — the password hash and tokens are never exposed to the build.

Enabling this widens the server's attack surface (it now runs a compiler on
request). Keep it off unless you use it, keep `M12_BUILD_TOKEN` set, and never
expose the dashboard port directly — it stays on loopback behind Caddy.

## What the server does for security

- Password is stored only as a scrypt hash in `.env`; nothing secret ships to the browser.
- Sessions are random 256-bit IDs in an `HttpOnly; Secure; SameSite=Strict` `__Host-` cookie, 30 min idle / 12 h max.
- Login is rate limited (5 failures per IP per 15 min, 30 attempts/min overall) and takes the same time for a wrong username or a wrong password.
- POSTs must be JSON from the same origin (CSRF).
- Strict CSP, HSTS, no framing, no-sniff, no referrer.
- Static files are preloaded into memory, so URLs can't reach the filesystem.
- Body size, header size and slow-client timeouts are capped.
- Zero runtime npm dependencies.
