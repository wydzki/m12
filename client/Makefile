# m12 MIPS/ARM telemetry agent — fetch mbedTLS, build it, and link the agent.
#
#   make                 fresh big-endian MIPS musl build + arch verify (DEFAULT)
#   make quick           incremental build (reuse mbedTLS lib if already built)
#   make clean           remove the agent binary
#   make distclean       also remove the mbedTLS tree and tarball
#
# This Makefile is LOCKED to a MIPS musl toolchain: the default `make` always
# produces a fresh, verified big-endian MIPS binary, and a stray `CROSS=` on the
# command line (or a build button) can no longer retarget it to another arch.
#
# --- Build against musl, not glibc, for these devices -------------------------
# A glibc toolchain emits:
#   "Using 'getaddrinfo' in statically linked applications requires at runtime
#    the shared libraries from the glibc version used for linking."
# That is real: glibc's NSS (getaddrinfo/gethostbyname) dlopen()s libnss_* at
# runtime even from a -static binary, so a "static" glibc agent crashes on a
# device that has no matching glibc .so files. musl resolves names in-process,
# so a static musl binary is genuinely self-contained — nothing to ship besides
# the agent and its certs. This build uses a MIPS musl toolchain by default:
#
#   mips   (big-endian, DEFAULT)   make
#   mipsel (little-endian)         make MIPS_CROSS=mipsel-linux-musl-
#
# Prebuilt musl cross toolchains: https://musl.cc  or  https://toolchains.bootlin.com
# (download, add its bin/ to PATH; MIPS_CROSS must resolve to <prefix>gcc).
#
# The endpoint and cert paths are NOT baked in: the agent reads them at runtime
# from m12-agent.conf / $M12_CONFIG and $M12_HOST, $M12_PORT, $M12_REGION,
# $M12_CA, $M12_CERT, $M12_KEY (see m12-agent.conf.example). You can still pin
# build-time defaults with, e.g., CFLAGS='-Os -DSERVER_HOST=\"lab-ingest.lan\"'.
# -----------------------------------------------------------------------------
#
# Uses the mbedTLS release tarball (ships generated sources) so no Python or git
# submodules are needed — only a C toolchain. Override MBEDTLS_VERSION as needed,
# or point MBEDTLS at a prebuilt tree to skip the download.

# Locked MIPS musl toolchain. `override` means a command-line CROSS=... (or a
# build button passing the wrong prefix) is ignored — the build stays MIPS.
# Switch endianness with: make MIPS_CROSS=mipsel-linux-musl-
MIPS_CROSS      ?= mips-linux-musl-
override CROSS  := $(MIPS_CROSS)
CC               = $(CROSS)gcc
AR               = $(CROSS)ar

MBEDTLS_VERSION ?= 3.6.7
MBEDTLS         ?= mbedtls-$(MBEDTLS_VERSION)
MBEDTLS_LIB      = $(MBEDTLS)/library/libmbedtls.a
MBEDTLS_TARBALL  = mbedtls-$(MBEDTLS_VERSION).tar.bz2
# Release tags are "mbedtls-X.Y.Z" (not "vX.Y.Z"); the .tar.bz2 asset bundles generated sources.
MBEDTLS_URL      = https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-$(MBEDTLS_VERSION)/$(MBEDTLS_TARBALL)

# Trim per-connection TLS buffers: payloads are tiny and the server sends a small
# EC certificate, so 4 KB each way is plenty (default is 16 KB).
MBEDTLS_CFLAGS   = -Os -DMBEDTLS_SSL_IN_CONTENT_LEN=4096 -DMBEDTLS_SSL_OUT_CONTENT_LEN=4096

CFLAGS          ?= -Os -ffunction-sections -fdata-sections
LDFLAGS          = -static -Wl,--gc-sections -s
LIBS             = -lmbedtls -lmbedx509 -lmbedcrypto

BIN              = m12-agent

.PHONY: all fresh quick verify mbedtls clean distclean

# Default: a guaranteed-fresh MIPS batch. Remove the old binary, discard any
# previously-built mbedTLS objects (keeping the downloaded source, so no network
# round-trip), rebuild the library AND agent with the locked MIPS toolchain, then
# verify the result really is a big-endian MIPS binary before you stage it. This
# is why a plain `make` can never silently reuse a stale/wrong-arch binary.
all: fresh

fresh:
	rm -f $(BIN)
	@test ! -d "$(MBEDTLS)" || $(MAKE) -C "$(MBEDTLS)" clean   # drop wrong-arch objects, keep sources
	rm -f $(MBEDTLS_LIB)
	@$(MAKE) --no-print-directory quick
	@$(MAKE) --no-print-directory verify

# Incremental: build the agent, reusing the mbedTLS lib if it is already current.
# Faster, but trusts the existing lib — use `make`/`make fresh` when in doubt.
quick: $(BIN)

$(BIN): client.c $(MBEDTLS_LIB)
	$(CC) $(CFLAGS) $< -o $@ \
	    -I"$(MBEDTLS)/include" -L"$(MBEDTLS)/library" \
	    $(LDFLAGS) $(LIBS)
	@echo "built $@  (CROSS=$(CROSS))"
	@$(CROSS)size $@ 2>/dev/null || true

# Fail the build loudly unless the binary is a big-endian (MSB) MIPS ELF, so a
# wrong-arch artifact can never reach the staging step unnoticed.
verify:
	@if command -v file >/dev/null 2>&1; then \
	    desc=`file -b $(BIN)`; \
	    echo "$$desc" | grep -q 'MIPS' || { echo "VERIFY FAILED (not MIPS): $$desc"; exit 1; }; \
	    echo "$$desc" | grep -q 'MSB'  || { echo "VERIFY FAILED (not big-endian/MSB): $$desc"; exit 1; }; \
	    echo "verified big-endian MIPS: $$desc"; \
	else \
	    echo "note: 'file' not found on PATH; skipping arch verification"; \
	fi

mbedtls: $(MBEDTLS_LIB)

# No prerequisites: if the static lib already exists (e.g. a prebuilt MBEDTLS),
# make treats it as up to date and skips the download/build.
$(MBEDTLS_LIB):
	@test -f "$(MBEDTLS_TARBALL)" || curl -fsSLO "$(MBEDTLS_URL)"
	@test -d "$(MBEDTLS)" || tar xjf "$(MBEDTLS_TARBALL)"
	$(MAKE) -C "$(MBEDTLS)" CC=$(CC) AR=$(AR) CFLAGS="$(MBEDTLS_CFLAGS)" lib

clean:
	rm -f $(BIN)

distclean: clean
	rm -rf "$(MBEDTLS)" "$(MBEDTLS_TARBALL)"
