#!/bin/sh
# Verify the MIPS agent links cleanly and report its exact size.
#
# Fetches a standalone musl cross toolchain (no root, no container needed),
# builds the agent both stock and with MINIMAL_TLS=1, and prints the sizes side
# by side so you can confirm the ~800 KB -> ~200 KB drop before flashing.
#
#   scripts/verify-build.sh              # big-endian  (mips-,  your lab hardware)
#   scripts/verify-build.sh mipsel       # little-endian (mipsel-)
#
# Needs: a Linux x86_64 host with curl, tar, make, and xz/gzip. Run from the
# repo root. Downloads ~40 MB of toolchain into .toolchains/ (cached, reused).
set -eu

endian="${1:-mips}"            # "mips" (BE) or "mipsel" (LE)
case "$endian" in
  mips)   cross="mips-linux-musl" ;;
  mipsel) cross="mipsel-linux-musl" ;;
  *) echo "usage: $0 [mips|mipsel]" >&2; exit 2 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
tc_dir="$root/.toolchains"
tgz="$cross-cross.tgz"
tc_bin="$tc_dir/$cross-cross/bin"

mkdir -p "$tc_dir"
if [ ! -x "$tc_bin/$cross-gcc" ]; then
  echo ">> fetching toolchain: $tgz"
  curl -fSL -o "$tc_dir/$tgz" "https://musl.cc/$tgz"
  tar xzf "$tc_dir/$tgz" -C "$tc_dir"
fi
export PATH="$tc_bin:$PATH"
echo ">> using $($cross-gcc --version | head -1)"

cd "$root/client"

report() {  # <label>
  if [ -f m12-agent ]; then
    sz=$(wc -c < m12-agent)
    printf '   %-22s % 9d bytes  (%d KB)\n' "$1" "$sz" "$((sz / 1024))"
    "$cross-size" m12-agent 2>/dev/null || true
    file m12-agent 2>/dev/null || true
  fi
}

echo "========================================================"
echo " STOCK build (full mbedTLS)"
echo "========================================================"
make distclean >/dev/null 2>&1 || true
make MIPS_CROSS="$cross-"              # default target = fresh + arch verify
report "stock"

echo "========================================================"
echo " MINIMAL_TLS=1 build (trimmed mbedTLS)"
echo "========================================================"
# `fresh` (the default target) rebuilds every mbedTLS object + the agent with
# the minimal config define, reusing the already-downloaded source. No re-fetch.
make MINIMAL_TLS=1 MIPS_CROSS="$cross-"
report "minimal_tls"

echo
echo ">> done. Flash the MINIMAL_TLS binary (client/m12-agent)."
