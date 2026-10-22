# m12 MIPS telemetry agent — fetch mbedTLS, build it, and link the agent.
#
#   make CROSS=mipsel-linux-musl-     cross-compile for the device (match endianness)
#   make                              native build (dev box)
#   make clean                        remove the agent binary
#   make distclean                    also remove the mbedTLS tree and tarball
#
# Uses the mbedTLS release tarball (ships generated sources) so no Python or git
# submodules are needed — only a C toolchain. Override MBEDTLS_VERSION as needed,
# or point MBEDTLS at a prebuilt tree to skip the download.

CROSS           ?=
CC               = $(CROSS)gcc
AR               = $(CROSS)ar

MBEDTLS_VERSION ?= 3.6.2
MBEDTLS         ?= mbedtls-$(MBEDTLS_VERSION)
MBEDTLS_LIB      = $(MBEDTLS)/library/libmbedtls.a
MBEDTLS_TARBALL  = mbedtls-$(MBEDTLS_VERSION).tar.bz2
MBEDTLS_URL      = https://github.com/Mbed-TLS/mbedtls/releases/download/v$(MBEDTLS_VERSION)/$(MBEDTLS_TARBALL)

# Trim per-connection TLS buffers: payloads are tiny and the server sends a small
# EC certificate, so 4 KB each way is plenty (default is 16 KB).
MBEDTLS_CFLAGS   = -Os -DMBEDTLS_SSL_IN_CONTENT_LEN=4096 -DMBEDTLS_SSL_OUT_CONTENT_LEN=4096

CFLAGS          ?= -Os -ffunction-sections -fdata-sections
LDFLAGS          = -static -Wl,--gc-sections -s
LIBS             = -lmbedtls -lmbedx509 -lmbedcrypto

BIN              = m12-agent

.PHONY: all mbedtls clean distclean

all: $(BIN)

$(BIN): client.c $(MBEDTLS_LIB)
	$(CC) $(CFLAGS) $< -o $@ \
	    -I"$(MBEDTLS)/include" -L"$(MBEDTLS)/library" \
	    $(LDFLAGS) $(LIBS)
	@echo "built $@  (CROSS=$(CROSS))"
	@$(CROSS)size $@ 2>/dev/null || true

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
