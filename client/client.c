/*
 * m12 telemetry agent for embedded MIPS Linux (BusyBox, no Node/Python/OpenSSL).
 * mTLS client built on mbedTLS 3.x (tested against 3.6 LTS), statically linkable.
 *
 * Reads node.crt / node.key / ca.crt from disk, opens an mTLS connection to the
 * ingest listener, verifies the server certificate against ca.crt, and POSTs a
 * small JSON telemetry payload. The node's identity is its client certificate
 * CN, enforced server-side, so nothing here needs to send an id.
 *
 *   usage: m12-agent [status]        status = healthy|scanning|offline (default healthy)
 *   exit:  0 on HTTP 200, non-zero otherwise (supervisor/cron can alert).
 *
 * Build command is at the bottom of this file and in client/README.md.
 */
#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include "mbedtls/net_sockets.h"
#include "mbedtls/ssl.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "mbedtls/error.h"

/* ---- configuration (edit paths/host for your deployment) ---- */
#define SERVER_HOST "c.zki.lol"
#define SERVER_PORT "8443"
#define HTTP_PATH   "/ingest"          /* server route; NOT /api/ingest */
#define NODE_REGION "LAN"

#define CA_PATH   "ca.crt"
#define CERT_PATH "node.crt"
#define KEY_PATH  "node.key"
/* ------------------------------------------------------------- */

static void emit_err(const char *what, int ret)
{
    char buf[128];
    mbedtls_strerror(ret, buf, sizeof(buf));
    fprintf(stderr, "%s: -0x%04x %s\n", what, (unsigned)-ret, buf);
}

/* CPU busy percentage sampled over ~200ms from /proc/stat. */
static int read_cpu_totals(unsigned long long *idle, unsigned long long *total)
{
    FILE *f = fopen("/proc/stat", "r");
    if (!f) return -1;
    unsigned long long u = 0, n = 0, s = 0, i = 0, io = 0, irq = 0, sq = 0, st = 0;
    int got = fscanf(f, "cpu %llu %llu %llu %llu %llu %llu %llu %llu",
                     &u, &n, &s, &i, &io, &irq, &sq, &st);
    fclose(f);
    if (got < 4) return -1;
    *idle = i + io;
    *total = u + n + s + i + io + irq + sq + st;
    return 0;
}

static double cpu_percent(void)
{
    unsigned long long idle1, total1, idle2, total2;
    if (read_cpu_totals(&idle1, &total1) != 0) return 0.0;
    struct timespec ts = { 0, 200 * 1000 * 1000 }; /* 200 ms */
    nanosleep(&ts, NULL);
    if (read_cpu_totals(&idle2, &total2) != 0) return 0.0;
    unsigned long long dt = total2 - total1;
    unsigned long long di = idle2 - idle1;
    if (dt == 0) return 0.0;
    return 100.0 * (double)(dt - di) / (double)dt;
}

/* Used memory percentage from /proc/meminfo. */
static double mem_percent(void)
{
    FILE *f = fopen("/proc/meminfo", "r");
    if (!f) return 0.0;
    char line[128];
    unsigned long total = 0, avail = 0, freek = 0;
    while (fgets(line, sizeof(line), f)) {
        sscanf(line, "MemTotal: %lu kB", &total);
        sscanf(line, "MemAvailable: %lu kB", &avail);
        sscanf(line, "MemFree: %lu kB", &freek);
    }
    fclose(f);
    if (!total) return 0.0;
    unsigned long used = total - (avail ? avail : freek);
    return 100.0 * (double)used / (double)total;
}

int main(int argc, char **argv)
{
    const char *status = (argc > 1) ? argv[1] : "healthy";
    int ret = 1, exit_code = 1;

    mbedtls_net_context server_fd;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;
    mbedtls_ssl_context ssl;
    mbedtls_ssl_config conf;
    mbedtls_x509_crt cacert;
    mbedtls_x509_crt clicert;
    mbedtls_pk_context pkey;

    mbedtls_net_init(&server_fd);
    mbedtls_ssl_init(&ssl);
    mbedtls_ssl_config_init(&conf);
    mbedtls_x509_crt_init(&cacert);
    mbedtls_x509_crt_init(&clicert);
    mbedtls_pk_init(&pkey);
    mbedtls_ctr_drbg_init(&ctr_drbg);
    mbedtls_entropy_init(&entropy);

    const char *pers = "m12-agent";
    if ((ret = mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                                     (const unsigned char *)pers, strlen(pers))) != 0) {
        emit_err("ctr_drbg_seed", ret);
        goto exit;
    }

    if ((ret = mbedtls_x509_crt_parse_file(&cacert, CA_PATH)) != 0) {
        emit_err("load " CA_PATH, ret);
        goto exit;
    }
    if ((ret = mbedtls_x509_crt_parse_file(&clicert, CERT_PATH)) != 0) {
        emit_err("load " CERT_PATH, ret);
        goto exit;
    }
    /* mbedTLS 3.x: pk_parse_keyfile takes an RNG for key validation/blinding. */
    if ((ret = mbedtls_pk_parse_keyfile(&pkey, KEY_PATH, NULL,
                                        mbedtls_ctr_drbg_random, &ctr_drbg)) != 0) {
        emit_err("load " KEY_PATH, ret);
        goto exit;
    }

    if ((ret = mbedtls_net_connect(&server_fd, SERVER_HOST, SERVER_PORT,
                                   MBEDTLS_NET_PROTO_TCP)) != 0) {
        emit_err("connect", ret);
        goto exit;
    }

    if ((ret = mbedtls_ssl_config_defaults(&conf, MBEDTLS_SSL_IS_CLIENT,
                                           MBEDTLS_SSL_TRANSPORT_STREAM,
                                           MBEDTLS_SSL_PRESET_DEFAULT)) != 0) {
        emit_err("config_defaults", ret);
        goto exit;
    }

    /* Require a valid server certificate chained to our CA, and present ours. */
    mbedtls_ssl_conf_authmode(&conf, MBEDTLS_SSL_VERIFY_REQUIRED);
    mbedtls_ssl_conf_ca_chain(&conf, &cacert, NULL);
    mbedtls_ssl_conf_rng(&conf, mbedtls_ctr_drbg_random, &ctr_drbg);
    mbedtls_ssl_conf_min_tls_version(&conf, MBEDTLS_SSL_VERSION_TLS1_2);
    if ((ret = mbedtls_ssl_conf_own_cert(&conf, &clicert, &pkey)) != 0) {
        emit_err("conf_own_cert", ret);
        goto exit;
    }

    if ((ret = mbedtls_ssl_setup(&ssl, &conf)) != 0) {
        emit_err("ssl_setup", ret);
        goto exit;
    }
    /* SNI + verifies the server cert's SAN/CN matches SERVER_HOST. */
    if ((ret = mbedtls_ssl_set_hostname(&ssl, SERVER_HOST)) != 0) {
        emit_err("set_hostname", ret);
        goto exit;
    }
    mbedtls_ssl_set_bio(&ssl, &server_fd, mbedtls_net_send, mbedtls_net_recv, NULL);

    while ((ret = mbedtls_ssl_handshake(&ssl)) != 0) {
        if (ret != MBEDTLS_ERR_SSL_WANT_READ && ret != MBEDTLS_ERR_SSL_WANT_WRITE) {
            emit_err("handshake", ret);
            uint32_t flags = mbedtls_ssl_get_verify_result(&ssl);
            if (flags != 0) {
                char vb[256];
                mbedtls_x509_crt_verify_info(vb, sizeof(vb), "  ", flags);
                fprintf(stderr, "cert verify failed:\n%s", vb);
            }
            goto exit;
        }
    }

    /* Build payload, then the HTTP/1.1 request, in stack buffers. */
    char json[256];
    int blen = snprintf(json, sizeof(json),
                        "{\"status\":\"%s\",\"region\":\"%s\","
                        "\"metrics\":{\"cpu\":%.1f,\"mem\":%.1f}}",
                        status, NODE_REGION, cpu_percent(), mem_percent());
    if (blen < 0 || blen >= (int)sizeof(json)) {
        fprintf(stderr, "payload too large\n");
        goto close_notify;
    }

    char req[512];
    int rlen = snprintf(req, sizeof(req),
                        "POST %s HTTP/1.1\r\n"
                        "Host: %s:%s\r\n"
                        "Content-Type: application/json\r\n"
                        "Content-Length: %d\r\n"
                        "Connection: close\r\n\r\n%s",
                        HTTP_PATH, SERVER_HOST, SERVER_PORT, blen, json);
    if (rlen < 0 || rlen >= (int)sizeof(req)) {
        fprintf(stderr, "request too large\n");
        goto close_notify;
    }

    for (int written = 0; written < rlen; ) {
        ret = mbedtls_ssl_write(&ssl, (const unsigned char *)req + written, rlen - written);
        if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
        if (ret <= 0) {
            emit_err("ssl_write", ret);
            goto close_notify;
        }
        written += ret;
    }

    /* Read enough of the response to recover the status code. */
    unsigned char buf[512];
    int n = 0;
    do {
        ret = mbedtls_ssl_read(&ssl, buf + n, sizeof(buf) - 1 - n);
        if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
        if (ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || ret == 0) break;
        if (ret < 0) {
            emit_err("ssl_read", ret);
            goto close_notify;
        }
        n += ret;
    } while (n < (int)sizeof(buf) - 1 &&
             !(n >= 12 && memchr(buf, '\n', n))); /* got at least the status line */
    buf[n] = '\0';

    {
        int code = 0;
        /* status line looks like: HTTP/1.1 200 OK */
        if (n >= 12 && sscanf((char *)buf + 9, "%d", &code) == 1 && code == 200) {
            printf("ok: %s\n", buf); /* server echoes {"ok":true,"node":"..."} */
            exit_code = 0;
        } else {
            fprintf(stderr, "server rejected: %.*s\n", n, buf);
        }
    }

close_notify:
    mbedtls_ssl_close_notify(&ssl);

exit:
    mbedtls_net_free(&server_fd);
    mbedtls_ssl_free(&ssl);
    mbedtls_ssl_config_free(&conf);
    mbedtls_x509_crt_free(&cacert);
    mbedtls_x509_crt_free(&clicert);
    mbedtls_pk_free(&pkey);
    mbedtls_ctr_drbg_free(&ctr_drbg);
    mbedtls_entropy_free(&entropy);
    return exit_code;
}

/*
 * Static build (cross-compile for the device's MIPS toolchain):
 *
 *   mips-linux-musl-gcc -Os -ffunction-sections -fdata-sections -static \
 *       client.c -o m12-agent \
 *       -I"$MBEDTLS/include" -L"$MBEDTLS/library" \
 *       -Wl,--gc-sections -lmbedtls -lmbedx509 -lmbedcrypto -s
 *
 * Library order matters: -lmbedtls -lmbedx509 -lmbedcrypto.
 * See client/README.md for building mbedTLS itself for MIPS.
 */
