# m12 MIPS/ARM telemetry agent — fetch mbedTLS, build it, and link the agent.
#
#   make                 build BOTH big-endian + little-endian MIPS32 (DEFAULT)
#   make be              big-endian only   (m12-agent-mips + .gz)
#   make le              little-endian only (m12-agent-mipsel + .gz)
#   make quick           incremental single build (reuse mbedTLS lib if already built)
#   make gz              gzip the binary (for TFTP on high-latency links)
#   make clean           remove agent binaries (both endiannesses)
#   make distclean       also remove the mbedTLS tree and tarball
#
# This Makefile is LOCKED to a MIPS musl toolchain: the default `make` always
# produces fresh, verified MIPS32 binaries for both endiannesses, and a stray
# `CROSS=` on the command line (or a build button) can no longer retarget it to
# another arch.
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
#   mips   (big-endian)            make be
#   mipsel (little-endian)         make le
#   both   (DEFAULT)               make
#
# Prebuilt musl cross toolchains: https://musl.cc  or  https://toolchains.bootlin.com
# (download, add its bin/ to PATH; MIPS_CROSS must resolve to <prefix>gcc).
#
# The endpoint and cert paths are NOT baked in: the agent reads them at runtime
# from m12-agent.conf / $M12_CONFIG and $M12_HOST, $M12_PORT, $M12_REGION,
# $M12_CA, $M12_CERT, $M12_KEY (see m12-agent.conf.example). Edit the #define
# defaults in client.c to change the compile-time fallback.
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

# Pin the ISA to MIPS32 (o32 ABI). Home-router cores (AR9xxx/ath79 24Kc,
# MT7620/MT7621 24KEc, BCM63xx) are MIPS32, almost all r2 — but plain `mips32`
# is the broadest baseline and still runs on r2 parts. This guards against a
# toolchain whose default is MIPS64/n32/n64. Override for an r2-only fleet with
# `make MIPS_ARCH=mips32r2`.
MIPS_ARCH       ?= mips32
MIPS_ABI        ?= 32
ARCHFLAGS        = -march=$(MIPS_ARCH) -mabi=$(MIPS_ABI)

MBEDTLS_VERSION ?= 3.6.7
MBEDTLS         ?= mbedtls-$(MBEDTLS_VERSION)
MBEDTLS_LIB      = $(MBEDTLS)/library/libmbedtls.a
MBEDTLS_TARBALL  = mbedtls-$(MBEDTLS_VERSION).tar.bz2
# Release tags are "mbedtls-X.Y.Z" (not "vX.Y.Z"); the .tar.bz2 asset bundles generated sources.
MBEDTLS_URL      = https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-$(MBEDTLS_VERSION)/$(MBEDTLS_TARBALL)

# Shared compiler flags for the mbedTLS library build.
MBEDTLS_CFLAGS   = -Os $(ARCHFLAGS) -ffunction-sections -fdata-sections

# MINIMAL_TLS=1 compiles mbedTLS (and the agent) against mbedtls_config.min.h,
# which enables ONLY TLS 1.2 + ECDHE-ECDSA-AES128-GCM-SHA256 + P-256. This is the
# big size win (stock mbedTLS ~800 KB -> ~200 KB or less).
#
# Instead of passing -DMBEDTLS_CONFIG_FILE via CFLAGS (which requires nested
# quoting through make -> sh -> sub-make -> sh -> gcc that no single escaping
# survives), the build copies mbedtls_config.min.h over the stock config in the
# mbedTLS tree. Both the library and the agent then pick it up through the
# default #include "mbedtls/mbedtls_config.h" path — no -D flag, no quoting.
ifdef MINIMAL_TLS
TLS_CONFIG      := mbedtls_config.min.h
# Also compile the library with LTO + all the same stripping flags so the linker
# can do function-level DCE across mbedTLS, not just section-level GC.
MBEDTLS_CFLAGS  += -flto -fno-asynchronous-unwind-tables -fno-unwind-tables \
                   -fno-stack-protector -fno-ident
else
# When using the stock config (16 KB default buffers), shrink to 4 KB for the
# tiny payloads on these devices. The minimal config already defines these.
MBEDTLS_CFLAGS  += -DMBEDTLS_SSL_IN_CONTENT_LEN=4096 -DMBEDTLS_SSL_OUT_CONTENT_LEN=4096
endif

# Fleet flow (one image for many routers): EMBED_CA=1 bakes in ONLY the
# shared CA (public, not secret), so the flashed binary is byte-for-byte identical
# on every node. Each device carries its own identity in a single node.pem (cert
# + key) — the build defaults the identity path to node.pem. Per-node identity and
# per-node revocation are preserved; you just flash + drop one small file.
#
#   make EMBED_CA=1 MINIMAL_TLS=1 MIPS_CROSS=mipsel-linux-musl- CA=../pki/ca.crt
#
# EMBED_CERTS=1 instead bakes in all three (CA+cert+key) -> a fully standalone
# binary with nothing else to copy to the device. Two ways to use it:
#   * per-node  : a different cert per router -> one build per router, each keeps
#                 its own identity + revocation (binary differs between routers).
#   * shared/fleet: ONE cert used for the whole fleet -> a single identical binary
#                 flashed to every router, nothing else on the device. Simplest to
#                 deploy, but all routers share one identity: they appear as a
#                 single node on the dashboard and revoke affects them all. The
#                 binary embeds that shared private key, so treat it as a secret.
#
#   # shared/fleet image (mint one cert for the whole fleet, then build once):
#   #   ./scripts/pki.sh node-cert homelab-fleet
#   make EMBED_CERTS=1 MINIMAL_TLS=1 CA=../pki/ca.crt \
#        CERT=../pki/homelab-fleet.crt KEY=../pki/homelab-fleet.key
EMBED_HDR       := embedded_certs.h
CA              ?=
CERT            ?=
KEY             ?=
ifdef EMBED_CERTS
override AGENT_CPPFLAGS += -DEMBED_CERTS
EMBED_DEP       := $(EMBED_HDR)
EMBED_GEN_ARGS   = "$(CA)" "$(CERT)" "$(KEY)"
else ifdef EMBED_CA
override AGENT_CPPFLAGS += -DEMBED_CA -DIDENTITY_PATH='"node.pem"'
EMBED_DEP       := $(EMBED_HDR)
EMBED_GEN_ARGS   = "$(CA)"
endif

# Size-oriented codegen, applied to the agent object (ARCHFLAGS pins MIPS32).
# -flto lets dead code be dropped across the agent + mbedTLS; drop it if your
# toolchain throws LTO link errors. Unwind/stack-protector tables are dead weight
# on a tiny single-shot agent.
SIZEFLAGS        = $(ARCHFLAGS) -flto -fno-stack-protector \
                   -fno-asynchronous-unwind-tables -fno-unwind-tables \
                   -fomit-frame-pointer -fno-ident

CFLAGS          ?= -Os -ffunction-sections -fdata-sections
AGENT_CFLAGS     = $(CFLAGS) $(SIZEFLAGS) $(AGENT_CPPFLAGS)
LDFLAGS          = -static -flto -Wl,--gc-sections -Wl,--as-needed \
                   -Wl,--build-id=none -s
LIBS             = -lmbedtls -lmbedx509 -lmbedcrypto

BIN             ?= m12-agent
BIN_BE           = m12-agent-mips
BIN_LE           = m12-agent-mipsel

.PHONY: all both be le fresh quick verify mbedtls gz clean distclean

# Default: build BOTH big-endian and little-endian MIPS32 binaries. Each gets a
# fresh mbedTLS rebuild with the matching toolchain, arch verification, and gzip.
all: both

both:
	@echo "=== big-endian MIPS32 (mips) ==="
	@$(MAKE) --no-print-directory fresh MIPS_CROSS=mips-linux-musl- BIN=$(BIN_BE)
	@echo ""
	@echo "=== little-endian MIPS32 (mipsel) ==="
	@$(MAKE) --no-print-directory fresh MIPS_CROSS=mipsel-linux-musl- BIN=$(BIN_LE)
	@echo ""
	@ls -l $(BIN_BE) $(BIN_BE).gz $(BIN_LE) $(BIN_LE).gz 2>/dev/null || true
	@echo "done: $(BIN_BE) + $(BIN_LE)"

be:
	@$(MAKE) --no-print-directory fresh MIPS_CROSS=mips-linux-musl- BIN=$(BIN_BE)

le:
	@$(MAKE) --no-print-directory fresh MIPS_CROSS=mipsel-linux-musl- BIN=$(BIN_LE)

fresh:
	rm -f $(BIN) $(BIN).gz
	@test ! -d "$(MBEDTLS)" || $(MAKE) -C "$(MBEDTLS)" clean   # drop wrong-arch objects, keep sources
	rm -f $(MBEDTLS_LIB)
	@$(MAKE) --no-print-directory quick
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory gz

# Incremental: build the agent, reusing the mbedTLS lib if it is already current.
# Faster, but trusts the existing lib — use `make`/`make fresh` when in doubt.
quick: $(BIN)

# Regenerate the embedded-certs header whenever the source PEMs change (only a
# prerequisite when EMBED_CA / EMBED_CERTS is set, so a normal build needs none).
$(EMBED_HDR): $(CA) $(CERT) $(KEY)
	@test -n "$(CA)" || { echo "embedding needs CA= (path to pki/ca.crt)"; exit 1; }
	@test -z "$(EMBED_CERTS)" || { test -n "$(CERT)" && test -n "$(KEY)"; } || \
	    { echo "EMBED_CERTS=1 also requires CERT= and KEY= (this node's cert + key)"; exit 1; }
	../scripts/embed-certs.sh $(EMBED_GEN_ARGS) > $@
	@echo "generated $@"

$(BIN): client.c $(EMBED_DEP) $(MBEDTLS_LIB)
	$(CC) $(AGENT_CFLAGS) $< -o $@ \
	    -I"$(MBEDTLS)/include" -L"$(MBEDTLS)/library" \
	    $(LDFLAGS) $(LIBS)
	@echo "built $@  (CROSS=$(CROSS), arch=$(MIPS_ARCH)/$(MIPS_ABI), minimal_tls=$(if $(MINIMAL_TLS),yes,no))"
	@$(CROSS)size $@ 2>/dev/null || true

# Fail the build loudly unless the binary is a 32-bit MIPS ELF with the endianness
# that matches the toolchain, so a wrong-arch artifact can never reach staging.
# Endianness is derived from CROSS (mipsel/mipsle -> little-endian/LSB), so a
# legitimate `make MIPS_CROSS=mipsel-linux-musl-` build verifies instead of being
# rejected for not being big-endian.
verify:
	@if command -v file >/dev/null 2>&1; then \
	    desc=`file -b $(BIN)`; \
	    case "$(CROSS)" in \
	        *mipsel*|*mipsle*) want=LSB; wname="little-endian (LSB)";; \
	        *)                 want=MSB; wname="big-endian (MSB)";; \
	    esac; \
	    echo "$$desc" | grep -q 'MIPS'    || { echo "VERIFY FAILED (not MIPS): $$desc"; exit 1; }; \
	    echo "$$desc" | grep -q '32-bit'  || { echo "VERIFY FAILED (not 32-bit MIPS): $$desc"; exit 1; }; \
	    echo "$$desc" | grep -q "$$want"  || { echo "VERIFY FAILED (expected $$wname for CROSS=$(CROSS)): $$desc"; exit 1; }; \
	    echo "verified 32-bit $$wname MIPS: $$desc"; \
	else \
	    echo "note: 'file' not found on PATH; skipping arch verification"; \
	fi

mbedtls: $(MBEDTLS_LIB)

# No prerequisites: if the static lib already exists (e.g. a prebuilt MBEDTLS),
# make treats it as up to date and skips the download/build.
$(MBEDTLS_LIB):
	@test -f "$(MBEDTLS_TARBALL)" || curl -fsSLO "$(MBEDTLS_URL)"
	@test -d "$(MBEDTLS)" || tar xjf "$(MBEDTLS_TARBALL)"
	@test -z "$(TLS_CONFIG)" || { \
	    cp "$(TLS_CONFIG)" "$(MBEDTLS)/include/mbedtls/mbedtls_config.h"; \
	    echo "installed $(TLS_CONFIG) -> $(MBEDTLS)/include/mbedtls/mbedtls_config.h"; \
	}
	$(MAKE) -C "$(MBEDTLS)" CC=$(CC) AR=$(AR) CFLAGS="$(MBEDTLS_CFLAGS)" lib

# Gzip the binary for high-latency TFTP. Decompress on the router:
#   busybox gunzip m12-agent.gz && chmod +x m12-agent
gz: $(BIN)
	gzip -9kf $(BIN)
	@printf 'compressed  '; ls -l $(BIN).gz | awk '{printf "%s (%d bytes)\n", $$5, $$5}'

clean:
	rm -f $(BIN) $(BIN).gz $(BIN_BE) $(BIN_BE).gz $(BIN_LE) $(BIN_LE).gz $(EMBED_HDR)

distclean: clean
	rm -rf "$(MBEDTLS)" "$(MBEDTLS_TARBALL)"
