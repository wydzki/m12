# m12 MIPS telemetry agent (C / mbedTLS)

A static mTLS client for BusyBox MIPS devices with no Node/Python/OpenSSL.
Targets **mbedTLS 3.x** (tested against 3.6 LTS).

The node authenticates with its client certificate; the server derives the node
id from the cert CN, so the binary carries no secret beyond `node.key`.

## Files the agent needs at runtime

Put these next to the binary (or edit the `*_PATH` defines in `client.c`):

```
ca.crt     your m12 CA (from ./scripts/pki.sh init-ca)
node.crt   this node's cert (./scripts/pki.sh node-cert node-mips-0007)
node.key   this node's private key — unique per node, keep 0600
```

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
(`MBEDTLS_SSL_IN/OUT_CONTENT_LEN`) to cut per-connection RAM. To shrink further,
disable TLS 1.3 and unused ciphers in `mbedtls-*/include/mbedtls/mbedtls_config.h`
before building (the server only needs TLS 1.2 + ECDHE-ECDSA-AES-GCM).

Already have mbedTLS built? Point the Makefile at it and it skips the download:
`make CROSS=… MBEDTLS=/path/to/mbedtls-tree`.

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
