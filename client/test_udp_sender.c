/*
 * Test harness: rate-limited UDP sender against a local listener.
 *
 * Build:
 *   gcc -O2 -Wall -Wextra -pthread \
 *       rate_limiter.c udp_sender.c test_udp_sender.c -o test_udp
 *
 * Expected: ~50K pps, ~25 MB/s, loopback loss ~0.
 */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <sys/time.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <string.h>
#include <pthread.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include "rate_limiter.h"
#include "udp_sender.h"

#define LISTEN_PORT  9999
#define PKT_SIZE     512
#define PPS_CAP      50000
#define BPS_CAP      25000000    /* 25 MB/s */
#define BURST_PPS    500
#define BURST_BPS    256000
#define DURATION_SEC 5

static atomic_int      g_listener_run = 1;
static atomic_uint_least64_t g_rx_packets = 0;
static atomic_uint_least64_t g_rx_bytes   = 0;

static void *listener(void *arg)
{
    int fd = *(int *)arg;

    struct timeval tv = { .tv_sec = 0, .tv_usec = 100000 }; /* 100ms */
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    char buf[65536];
    while (atomic_load_explicit(&g_listener_run, memory_order_relaxed)) {
        ssize_t n = recvfrom(fd, buf, sizeof(buf), 0, NULL, NULL);
        if (n > 0) {
            atomic_fetch_add_explicit(&g_rx_packets, 1, memory_order_relaxed);
            atomic_fetch_add_explicit(&g_rx_bytes, (uint64_t)n, memory_order_relaxed);
        }
    }
    close(fd);
    return NULL;
}

/* Bind listener socket in main thread — no startup race. */
static int bind_listener(void)
{
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { perror("listener socket"); return -1; }

    int want = 4 * 1024 * 1024;
    setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &want, sizeof(want));
    int got = 0;
    socklen_t optlen = sizeof(got);
    getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &got, &optlen);
    printf("listener SO_RCVBUF: requested %d, actual %d\n", want, got);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_port        = htons(LISTEN_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("listener bind");
        close(fd);
        return -1;
    }
    return fd;
}

int main(void)
{
    printf("=== udp sender test ===\n");
    printf("config:  pps=%d  bps=%d  pkt_size=%d  duration=%ds\n",
           PPS_CAP, BPS_CAP, PKT_SIZE, DURATION_SEC);
    printf("         target=127.0.0.1:%d\n\n", LISTEN_PORT);

    /* Bind listener in main thread, then hand fd to listener thread */
    int listen_fd = bind_listener();
    if (listen_fd < 0) return 1;
    pthread_t ltid;
    pthread_create(&ltid, NULL, listener, &listen_fd);

    /* Init rate limiter */
    rate_limiter_t rl;
    rate_limiter_init(&rl, PPS_CAP, BPS_CAP, BURST_PPS, BURST_BPS);

    /* Init sender */
    udp_sender_t sender;
    if (udp_sender_init(&sender, "127.0.0.1", LISTEN_PORT) != 0) {
        fprintf(stderr, "sender init failed\n");
        return 1;
    }

    /* Build payload */
    unsigned char payload[PKT_SIZE];
    udp_build_payload(payload, PKT_SIZE);

    /* Send */
    printf("sending...\n");
    udp_stats_t st = udp_sender_run(&sender, &rl, payload, PKT_SIZE,
                                     (double)DURATION_SEC);

    /* Let listener drain the last packets */
    struct timespec drain = { .tv_sec = 0, .tv_nsec = 200000000 };
    nanosleep(&drain, NULL);
    atomic_store_explicit(&g_listener_run, 0, memory_order_relaxed);
    pthread_join(ltid, NULL);

    uint64_t rx_p = atomic_load(&g_rx_packets);
    uint64_t rx_b = atomic_load(&g_rx_bytes);

    double pps = (double)st.packets / DURATION_SEC;
    double bps = (double)st.bytes   / DURATION_SEC;

    /* Which limit binds? */
    double eff_pps = PPS_CAP;
    double bps_pps = (double)BPS_CAP / PKT_SIZE;
    const char *binding = "pps";
    if (bps_pps < eff_pps) { eff_pps = bps_pps; binding = "bps"; }
    double eff_bps = eff_pps * PKT_SIZE;

    printf("\nsend stats:\n");
    printf("  packets sent: %" PRIu64 "  (%.0f pps, cap %.0f, %.1f%%)\n",
           st.packets, pps, eff_pps, pps / eff_pps * 100.0);
    printf("  bytes sent:   %" PRIu64 "  (%.0f Bps, cap %.0f, %.1f%%)\n",
           st.bytes, bps, eff_bps, bps / eff_bps * 100.0);
    printf("  binding limit: %s\n", binding);

    printf("\nlistener stats:\n");
    printf("  packets recv: %" PRIu64 "\n", rx_p);
    printf("  bytes recv:   %" PRIu64 "\n", rx_b);

    int64_t lost_p = (int64_t)st.packets - (int64_t)rx_p;
    printf("\nloopback loss: %" PRId64 " packets (%.2f%%)\n",
           lost_p,
           st.packets > 0 ? (double)lost_p / (double)st.packets * 100.0 : 0.0);

    udp_sender_destroy(&sender);
    rate_limiter_destroy(&rl);
    return 0;
}
