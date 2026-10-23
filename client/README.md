# m12 MIPS telemetry agent (C / mbedTLS)

A static mTLS client for BusyBox MIPS devices with no Node/Python/OpenSSL.
Targets **mbedTLS 3.x** (tested against 3.6 LTS).

The node authenticates with its client certificate; the server derives the node
id from the cert CN, so the binary carries no secret beyond `node.key`.

## Files the agent needs at runtime

By default, put these next to the binary (or edit the `*_PATH` defines in `client.c`):

```
ca.crt     your m12 CA (from ./scripts/pki.sh init-ca)
node.crt   this node's cert (./scripts/pki.sh node-cert node-mips-0007)
node.key   this node's private key — unique per node, keep 0600
```

**Or embed them for a single-file deploy** (`make EMBED_CERTS=1 …`, below): the
CA, cert and key are compiled into the binary, so you copy exactly **one** file
to the device and nothing else. That binary then *contains* the node's private
key, so it carries the same secrecy as `node.key` did — it's unique per node,
keep it `0700`, and never share it between nodes or commit it.

The embedded mTLS cert is also the "authentication" you want: the server drops
any node whose cert isn't signed by your CA (handshake fails before any code
runs), and the agent verifies the server against the embedded CA — so a stranger
can neither impersonate a node nor stand up a fake server to command yours.

The server host/port are compile-time defines (`SERVER_HOST`, `SERVER_PORT`) —
`c.zki.lol:8443`. The ingest path is `/ingest` (the `/api/*` routes are the
dashboard, a different listener).

## 1. Build it (one step)

The [`Makefile`](Makefile) downloads the mbedTLS release tarball (which ships
generated sources — no Python or git submodules needed), cross-builds it, and
links the agent. Match the toolchain prefix to your hardware: big-endian cores
use `mips-*`, little-endian use `mipsel-*`. A **musl** toolchain gives a far
smaller static binary than glibc (glibc static pulls in ~1 MB of libc);
OpenWrt/Buildroot SDKs ship suitable ones.

```sh
make CROSS=mipsel-linux-musl-     # device build
make                              # native build on a dev box (quick iteration)
make distclean                    # remove the mbedTLS tree + tarball
```

The Makefile builds mbedTLS with 4 KB TLS buffers
(`MBEDTLS_SSL_IN/OUT_CONTENT_LEN`) to cut per-connection RAM. For the big flash
win, build with a trimmed mbedTLS config:

```sh
make MINIMAL_TLS=1                      # big-endian
make MINIMAL_TLS=1 MIPS_CROSS=mipsel-linux-musl-   # little-endian (MT76xx/Ralink)
```

`MINIMAL_TLS=1` compiles mbedTLS **and** the agent against
[`mbedtls_config.min.h`](mbedtls_config.min.h), which enables only what the
server speaks — TLS 1.2 + ECDHE-ECDSA-AES128-GCM-SHA256 + P-256 — dropping
TLS 1.3, RSA, DHE/PSK, CBC/CCM/ChaCha20, every curve but P-256, and the error
strings. That typically takes the static binary from ~800 KB to ~200 KB or
below. If a build stops with an `#error` from `check_config.h`, it names the one
dependency to re-enable in that file. The ISA is pinned to MIPS32 (`-march=mips32
-mabi=32`, override with `MIPS_ARCH=mips32r2`), and `make` verifies the binary is
32-bit MIPS with the endianness matching your toolchain before staging.

Already have mbedTLS built? Point the Makefile at it and it skips the download:
`make CROSS=… MBEDTLS=/path/to/mbedtls-tree`.

### Fleet build — one image for many routers (recommended)

Flash the **same binary** to every node and give each device one small
`node.pem`. The CA (shared, public) is baked into the binary; each `node.pem`
holds that device's cert + key, so per-node identity and per-node revocation are
preserved.

```sh
# build ONE image for the whole fleet (CA embedded, endpoint baked in)
make EMBED_CA=1 MINIMAL_TLS=1 \
     MIPS_CROSS=mipsel-linux-musl- \
     CA=../pki/ca.crt \
     CFLAGS='-Os -DSERVER_HOST="ingest.example.com" -DSERVER_PORT="8802"'

# mint one identity per router (also writes pki/<id>.pem = cert + key)
./scripts/pki.sh node-cert node-mips-0001
./scripts/pki.sh node-cert node-mips-0002   # ... one per device
```

Per device: flash the identical `m12-agent`, then drop that router's
`pki/node-mips-000N.pem` next to it **as `node.pem`** (`chmod 600`). The agent
defaults its identity path to `node.pem` (override with `M12_IDENTITY=` or an
`identity=` line in `m12-agent.conf`). Each node still appears, and revokes,
separately on the dashboard.

### Embed everything — one standalone file, nothing else on the device

`EMBED_CERTS=1` bakes in the CA **and** the cert + key, so the binary is fully
self-contained: copy one file, `chmod 700`, run. Two ways to use it:

**Shared / fleet image — one identical binary for every router.** Mint a single
cert for the whole fleet and build once; flash that same file everywhere:

```sh
./scripts/pki.sh node-cert homelab-fleet     # one shared membership cert
make EMBED_CERTS=1 MINIMAL_TLS=1 \
     MIPS_CROSS=mips-linux-musl- \
     CA=../pki/ca.crt \
     CERT=../pki/homelab-fleet.crt KEY=../pki/homelab-fleet.key \
     CFLAGS='-Os -DSERVER_HOST="ingest.example.com" -DSERVER_PORT="8802"'
```

Simplest possible deploy — one file, no per-device step. **Distinct nodes:** each
router auto-derives its node id from its MAC (`node-aabbccddeeff`) and reports it,
so they show up as separate nodes on the dashboard even though the binary is
identical. Override the id per device if you prefer with `$M12_NODE` / a `node =`
config line, or pick the interface with `$M12_IFACE`.

Understand the trust model: the shared cert proves **fleet membership**, not
which router. The per-node id is self-reported, so it separates nodes
*organizationally*, not cryptographically — any holder of the shared binary/key
could claim any id. Revoking a single reported id (adding it to the revocation
file) stops a well-behaved node; revoking the shared cert CN (`homelab-fleet`)
is what actually cuts the whole fleet off. The binary embeds the shared key, so
treat the file as a secret (don't publish it). If you need a real per-node
security boundary + individual revocation, use the `EMBED_CA` + `node.pem` flow
(identical binary, one small per-device file) instead.

**Per-node — a distinct binary per router.** Same command but with that router's
own cert/key (`node-mips-0007.crt/.key`); keeps per-node identity + revocation,
at the cost of one build per router. (For identical-binary **with** per-node
identity, use the `EMBED_CA` fleet flow above instead.)

[`scripts/embed-certs.sh`](../scripts/embed-certs.sh) turns the PEM file(s) into
`embedded_certs.h` (regenerated every build; git-ignored). `EMBED_CA` embeds only
the CA; `EMBED_CERTS` embeds all three.

## 2. Or build by hand (the raw gcc command)

mbedTLS once (release tarball → no Python/submodules):

```sh
curl -fsSLO https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2
tar xjf mbedtls-3.6.7.tar.bz2 && cd mbedtls-3.6.7
make CC=mipsel-linux-musl-gcc AR=mipsel-linux-musl-ar \
     CFLAGS="-Os -DMBEDTLS_SSL_IN_CONTENT_LEN=4096 -DMBEDTLS_SSL_OUT_CONTENT_LEN=4096" lib
export MBEDTLS=$PWD && cd ..
```

Then the agent:

```sh
mipsel-linux-musl-gcc -Os -ffunction-sections -fdata-sections -static \
    client.c -o m12-agent \
    -I"$MBEDTLS/include" -L"$MBEDTLS/library" \
    -Wl,--gc-sections -lmbedtls -lmbedx509 -lmbedcrypto -s
```

- `-static` → no shared-library dependencies on the device.
- Link order **must** be `-lmbedtls -lmbedx509 -lmbedcrypto` (TLS → X.509 → crypto).
- `-Os -ffunction-sections -fdata-sections -Wl,--gc-sections -s` drop unused code
  and symbols; the agent object itself is a few KB, mbedTLS dominates size.

## 3. Run it

```sh
cd /etc/m12            # where ca.crt/node.crt/node.key live
./m12-agent healthy    # status: healthy | scanning | offline (default healthy)
echo $?                # 0 = server returned 200
```

Schedule it with a BusyBox crontab (every 5 min):

```
*/5 * * * * cd /etc/m12 && ./m12-agent healthy >/dev/null 2>&1
```

## Footprint notes

- No heap allocation in the agent itself; buffers are small stack arrays
  (`json[256]`, `req[512]`, `buf[512]`).
- With 4 KB TLS buffers, peak RAM per run is dominated by two ~4 KB TLS buffers
  plus the cert/key structures — comfortably under what a typical MIPS CPE has.
- Metrics come straight from `/proc/stat` and `/proc/meminfo`; no extra tools.
