/*
 * m12 telemetry + diagnostics agent for embedded MIPS Linux (BusyBox).
 * mTLS client on mbedTLS 3.x (tested against 3.6 LTS), statically linkable.
 *
 * Each run: open an mTLS connection to the ingest listener, POST telemetry to
 * /ingest, and read back any commands queued for THIS node (the server keys them
 * by our certificate CN). For each command: run it with popen(), capture output,
 * and POST the result to /output. Then exit — schedule it from cron/a timer.
 *
 *   usage: m12-agent [status]        status = healthy|scanning|offline (default healthy)
 *
 * SECURITY: /output and the command set are only ever exchanged over this mTLS
 * channel, and the server will only hand this agent commands addressed to its own
 * cert CN. Commands run as whatever user this process runs as (often root on
 * embedded devices) — enable the server-side allowlist if you don't want full shell.
 *
 * Build: see client/Makefile  (make CROSS=mips-linux-gnu-).
 */
#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <time.h>
#include <sys/wait.h>

#include "mbedtls/net_sockets.h"
#include "mbedtls/ssl.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "mbedtls/error.h"

#include "jsmn.h"

/* ---- configuration (edit host/paths for your deployment) ---- */
#define SERVER_HOST "ingest.zki.lol"   /* direct, NOT the Cloudflare-proxied name */
#define SERVER_PORT "8802"
#define HTTP_PATH        "/ingest"
#define HTTP_OUTPUT_PATH "/output"
#define NODE_REGION "LAN"

#define CA_PATH   "ca.crt"
#define CERT_PATH "node.crt"
#define KEY_PATH  "node.key"
/* ------------------------------------------------------------- */

#define RESP_CAP 16384   /* ingest response (telemetry ack + commands) */
#define OUT_CAP  8192    /* captured command output (truncated past this) */
#define ESC_CAP  16384   /* JSON-escaped output */
#define BODY_CAP 20480   /* /output request body */
#define REQ_CAP  24576   /* full HTTP request (headers + body) */
#define MAX_TOKS 512     /* jsmn token budget */

static mbedtls_entropy_context g_entropy;
static mbedtls_ctr_drbg_context g_ctr_drbg;
static mbedtls_x509_crt g_cacert;
static mbedtls_x509_crt g_clicert;
static mbedtls_pk_context g_pkey;
static mbedtls_ssl_config g_conf;

static char g_req[REQ_CAP];

static void emit_err(const char *what, int ret) {
  char buf[128];
  mbedtls_strerror(ret, buf, sizeof(buf));
  fprintf(stderr, "%s: -0x%04x %s\n", what, (unsigned)-ret, buf);
}

/* ---------- node metrics (BusyBox /proc) ---------- */

static int read_cpu_totals(unsigned long long *idle, unsigned long long *total) {
  FILE *f = fopen("/proc/stat", "r");
  if (!f) return -1;
  unsigned long long u = 0, n = 0, s = 0, i = 0, io = 0, irq = 0, sq = 0, st = 0;
  int got = fscanf(f, "cpu %llu %llu %llu %llu %llu %llu %llu %llu", &u, &n, &s, &i, &io, &irq, &sq, &st);
  fclose(f);
  if (got < 4) return -1;
  *idle = i + io;
  *total = u + n + s + i + io + irq + sq + st;
  return 0;
}

static double cpu_percent(void) {
  unsigned long long idle1, total1, idle2, total2;
  if (read_cpu_totals(&idle1, &total1) != 0) return 0.0;
  struct timespec ts = { 0, 200 * 1000 * 1000 };
  nanosleep(&ts, NULL);
  if (read_cpu_totals(&idle2, &total2) != 0) return 0.0;
  unsigned long long dt = total2 - total1, di = idle2 - idle1;
  return dt ? 100.0 * (double)(dt - di) / (double)dt : 0.0;
}

static double mem_percent(void) {
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

/* ---------- JSON helpers ---------- */

static int tok_eq(const char *json, const jsmntok_t *t, const char *s) {
  int len = t->end - t->start;
  return t->type == JSMN_STRING && (int)strlen(s) == len && strncmp(json + t->start, s, len) == 0;
}

static size_t json_escape(const char *s, size_t len, char *dst, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; i < len && o + 7 < cap; i++) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
    case '"':  dst[o++] = '\\'; dst[o++] = '"'; break;
    case '\\': dst[o++] = '\\'; dst[o++] = '\\'; break;
    case '\n': dst[o++] = '\\'; dst[o++] = 'n'; break;
    case '\r': dst[o++] = '\\'; dst[o++] = 'r'; break;
    case '\t': dst[o++] = '\\'; dst[o++] = 't'; break;
    default:
      if (c < 0x20) o += (size_t)snprintf(dst + o, cap - o, "\\u%04x", c);
      else dst[o++] = (char)c;
    }
  }
  dst[o] = 0;
  return o;
}

static size_t json_unescape(const char *s, size_t len, char *dst, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; i < len && o + 1 < cap; i++) {
    if (s[i] == '\\' && i + 1 < len) {
      i++;
      switch (s[i]) {
      case 'n': dst[o++] = '\n'; break;
      case 't': dst[o++] = '\t'; break;
      case 'r': dst[o++] = '\r'; break;
      case 'b': dst[o++] = '\b'; break;
      case 'f': dst[o++] = '\f'; break;
      case '/': dst[o++] = '/'; break;
      case '"': dst[o++] = '"'; break;
      case '\\': dst[o++] = '\\'; break;
      case 'u': if (i + 4 < len) { i += 4; dst[o++] = '?'; } break; /* non-ASCII unicode not needed for commands */
      default: dst[o++] = s[i];
      }
    } else {
      dst[o++] = s[i];
    }
  }
  dst[o] = 0;
  return o;
}

/* ---------- command execution ---------- */

static int run_command(const char *cmd, char *out, size_t cap, int *exit_code) {
  FILE *fp = popen(cmd, "r");
  if (!fp) {
    snprintf(out, cap, "popen failed: %s", strerror(errno));
    *exit_code = -1;
    return -1;
  }
  size_t n = 0, r;
  while (n < cap - 1 && (r = fread(out + n, 1, cap - 1 - n, fp)) > 0) n += r;
  out[n] = 0;
  /* drain any remaining output so pclose() doesn't block on a full pipe */
  char tmp[1024];
  while (fread(tmp, 1, sizeof(tmp), fp) > 0) { /* discard */ }
  int rc = pclose(fp);
  *exit_code = (rc == -1) ? -1 : (WIFEXITED(rc) ? WEXITSTATUS(rc) : -1);
  return 0;
}

/* ---------- TLS ---------- */

static int setup_tls(void) {
  int ret;
  const char *pers = "m12-agent";
  mbedtls_entropy_init(&g_entropy);
  mbedtls_ctr_drbg_init(&g_ctr_drbg);
  mbedtls_x509_crt_init(&g_cacert);
  mbedtls_x509_crt_init(&g_clicert);
  mbedtls_pk_init(&g_pkey);
  mbedtls_ssl_config_init(&g_conf);

  if ((ret = mbedtls_ctr_drbg_seed(&g_ctr_drbg, mbedtls_entropy_func, &g_entropy, (const unsigned char *)pers, strlen(pers))) != 0) { emit_err("drbg_seed", ret); return -1; }
  if ((ret = mbedtls_x509_crt_parse_file(&g_cacert, CA_PATH)) != 0) { emit_err("load " CA_PATH, ret); return -1; }
  if ((ret = mbedtls_x509_crt_parse_file(&g_clicert, CERT_PATH)) != 0) { emit_err("load " CERT_PATH, ret); return -1; }
  if ((ret = mbedtls_pk_parse_keyfile(&g_pkey, KEY_PATH, NULL, mbedtls_ctr_drbg_random, &g_ctr_drbg)) != 0) { emit_err("load " KEY_PATH, ret); return -1; }
  if ((ret = mbedtls_ssl_config_defaults(&g_conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT)) != 0) { emit_err("config_defaults", ret); return -1; }
  mbedtls_ssl_conf_authmode(&g_conf, MBEDTLS_SSL_VERIFY_REQUIRED);
  mbedtls_ssl_conf_ca_chain(&g_conf, &g_cacert, NULL);
  mbedtls_ssl_conf_rng(&g_conf, mbedtls_ctr_drbg_random, &g_ctr_drbg);
  mbedtls_ssl_conf_min_tls_version(&g_conf, MBEDTLS_SSL_VERSION_TLS1_2);
  if ((ret = mbedtls_ssl_conf_own_cert(&g_conf, &g_clicert, &g_pkey)) != 0) { emit_err("own_cert", ret); return -1; }
  return 0;
}

static void cleanup_tls(void) {
  mbedtls_ssl_config_free(&g_conf);
  mbedtls_x509_crt_free(&g_cacert);
  mbedtls_x509_crt_free(&g_clicert);
  mbedtls_pk_free(&g_pkey);
  mbedtls_ctr_drbg_free(&g_ctr_drbg);
  mbedtls_entropy_free(&g_entropy);
}

/* One request/response over a fresh mTLS connection. Returns the HTTP status
 * code (resp holds the full response, NUL-terminated), or -1 on failure. */
static int https_request(const char *path, const char *body, char *resp, size_t resp_cap) {
  int ret, status = -1;
  mbedtls_net_context fd;
  mbedtls_ssl_context ssl;
  mbedtls_net_init(&fd);
  mbedtls_ssl_init(&ssl);

  if ((ret = mbedtls_net_connect(&fd, SERVER_HOST, SERVER_PORT, MBEDTLS_NET_PROTO_TCP)) != 0) { emit_err("connect", ret); goto done; }
  if ((ret = mbedtls_ssl_setup(&ssl, &g_conf)) != 0) { emit_err("ssl_setup", ret); goto done; }
  if ((ret = mbedtls_ssl_set_hostname(&ssl, SERVER_HOST)) != 0) { emit_err("set_hostname", ret); goto done; }
  mbedtls_ssl_set_bio(&ssl, &fd, mbedtls_net_send, mbedtls_net_recv, NULL);

  while ((ret = mbedtls_ssl_handshake(&ssl)) != 0) {
    if (ret != MBEDTLS_ERR_SSL_WANT_READ && ret != MBEDTLS_ERR_SSL_WANT_WRITE) { emit_err("handshake", ret); goto done; }
  }

  int rlen = snprintf(g_req, sizeof(g_req),
                      "POST %s HTTP/1.1\r\nHost: %s:%s\r\nContent-Type: application/json\r\n"
                      "Content-Length: %d\r\nConnection: close\r\n\r\n%s",
                      path, SERVER_HOST, SERVER_PORT, (int)strlen(body), body);
  if (rlen < 0 || rlen >= (int)sizeof(g_req)) { fprintf(stderr, "request too large\n"); goto notify; }

  for (int w = 0; w < rlen; ) {
    ret = mbedtls_ssl_write(&ssl, (const unsigned char *)g_req + w, rlen - w);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
    if (ret <= 0) { emit_err("ssl_write", ret); goto notify; }
    w += ret;
  }

  size_t n = 0;
  for (;;) {
    ret = mbedtls_ssl_read(&ssl, (unsigned char *)resp + n, resp_cap - 1 - n);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
    if (ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || ret == 0) break;
    if (ret < 0) { emit_err("ssl_read", ret); break; }
    n += ret;
    if (n >= resp_cap - 1) break;
  }
  resp[n] = 0;
  if (n >= 12) sscanf(resp + 9, "%d", &status);

notify:
  mbedtls_ssl_close_notify(&ssl);
done:
  mbedtls_ssl_free(&ssl);
  mbedtls_net_free(&fd);
  return status;
}

static const char *http_body(const char *resp) {
  const char *b = strstr(resp, "\r\n\r\n");
  return b ? b + 4 : resp;
}

/* Parse the "commands" array from the /ingest response body, run each command,
 * and POST its output back. Command objects are flat {"id":..,"cmd":..}. */
static void process_commands(const char *json) {
  jsmn_parser p;
  jsmn_init(&p);
  static jsmntok_t toks[MAX_TOKS];
  int n = jsmn_parse(&p, json, strlen(json), toks, MAX_TOKS);
  if (n < 0) return;

  int ca = -1;
  for (int i = 0; i < n - 1; i++) {
    if (tok_eq(json, &toks[i], "commands") && toks[i + 1].type == JSMN_ARRAY) { ca = i + 1; break; }
  }
  if (ca < 0) return;

  int count = toks[ca].size;
  int t = ca + 1;
  for (int e = 0; e < count; e++) {
    if (toks[t].type != JSMN_OBJECT) break;
    int pairs = toks[t].size, cur = t + 1;
    const char *id = NULL, *cmd = NULL;
    int idlen = 0, cmdlen = 0;
    for (int k = 0; k < pairs; k++) {
      jsmntok_t *key = &toks[cur], *val = &toks[cur + 1];
      if (tok_eq(json, key, "id")) { id = json + val->start; idlen = val->end - val->start; }
      else if (tok_eq(json, key, "cmd")) { cmd = json + val->start; cmdlen = val->end - val->start; }
      cur += 2; /* flat objects: each value is a scalar token */
    }
    t = cur;

    if (!id || !cmd) continue;

    static char idbuf[64];
    int il = idlen < (int)sizeof(idbuf) - 1 ? idlen : (int)sizeof(idbuf) - 1;
    memcpy(idbuf, id, il);
    idbuf[il] = 0;

    static char cmdbuf[4096];
    json_unescape(cmd, cmdlen, cmdbuf, sizeof(cmdbuf));

    static char out[OUT_CAP];
    int exit_code = 0;
    run_command(cmdbuf, out, sizeof(out), &exit_code);

    static char esc[ESC_CAP];
    json_escape(out, strlen(out), esc, sizeof(esc));

    static char body[BODY_CAP];
    int bl = snprintf(body, sizeof(body), "{\"id\":\"%s\",\"output\":\"%s\",\"exitCode\":%d}", idbuf, esc, exit_code);
    if (bl < 0 || bl >= (int)sizeof(body)) continue;

    static char r2[2048];
    int code = https_request(HTTP_OUTPUT_PATH, body, r2, sizeof(r2));
    if (code != 200) fprintf(stderr, "output POST for %s: HTTP %d\n", idbuf, code);
  }
}

int main(int argc, char **argv) {
  const char *status = (argc > 1) ? argv[1] : "healthy";

  if (setup_tls() != 0) { cleanup_tls(); return 1; }

  static char tjson[256];
  snprintf(tjson, sizeof(tjson),
           "{\"status\":\"%s\",\"region\":\"%s\",\"metrics\":{\"cpu\":%.1f,\"mem\":%.1f}}",
           status, NODE_REGION, cpu_percent(), mem_percent());

  static char resp[RESP_CAP];
  int code = https_request(HTTP_PATH, tjson, resp, sizeof(resp));
  if (code != 200) {
    fprintf(stderr, "check-in failed: HTTP %d\n", code);
    cleanup_tls();
    return 1;
  }

  process_commands(http_body(resp));

  cleanup_tls();
  return 0;
}

/*
 * Static build (cross-compile for the device's MIPS toolchain):
 *   see client/Makefile  ->  make CROSS=mips-linux-gnu-
 * Library order matters: -lmbedtls -lmbedx509 -lmbedcrypto.
 */
