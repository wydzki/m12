/*
 * Test harness: 4 threads send as fast as the limiter allows for 10 seconds.
 * Reports actual vs configured pps/bps and identifies which limit is binding.
 *
 * Build:
 *   gcc -O2 -Wall -Wextra -pthread rate_limiter.c test_rate_limiter.c -o test_rl
 *
 * Expected output: achieved rate within ~1-2% of the binding limit.
 * The initial burst (buckets start full) is amortized over 10 seconds,
 * so its effect on the average is negligible.
 */
#define _POSIX_C_SOURCE 200112L
#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <pthread.h>
#include "rate_limiter.h"

#define N_THREADS    4
#define DURATION_SEC 10
#define PKT_SIZE     512

static rate_limiter_t g_rl;
static atomic_int g_run = 1;

typedef struct {
    int      id;
    uint64_t pkts;
    uint64_t bytes;
} worker_t;

static void *worker(void *arg)
{
    worker_t *w = arg;
    uint64_t p = 0, b = 0;
    while (atomic_load_explicit(&g_run, memory_order_relaxed)) {
        rate_limiter_acquire(&g_rl, PKT_SIZE);
        p++;
        b += PKT_SIZE;
    }
    w->pkts  = p;
    w->bytes = b;
    return NULL;
}

int main(void)
{
    double pps_cap  = 100000;       /* 100 K packets/sec  */
    double bps_cap  = 50000000;     /* 50 MB/sec          */
    double bpps     = 1000;         /* burst: 1000 packets */
    double bbps     = 512000;       /* burst: 512 KB       */

    printf("=== rate limiter test ===\n");
    printf("config:  pps_cap=%.0f  bps_cap=%.0f  burst_pps=%.0f  burst_bps=%.0f\n",
           pps_cap, bps_cap, bpps, bbps);
    printf("         threads=%d  duration=%ds  pkt_size=%d\n\n",
           N_THREADS, DURATION_SEC, PKT_SIZE);

    /*
     * Which limit is binding?
     *   pps limit → 100K pps × 512 B = 51.2 MB/s  (exceeds bps cap)
     *   bps limit → 50 MB/s ÷ 512 B  = 97,656 pps (below pps cap)
     * So bps is the binding constraint: expect ~97.6K pps / ~50 MB/s.
     */

    rate_limiter_init(&g_rl, pps_cap, bps_cap, bpps, bbps);

    pthread_t tids[N_THREADS];
    worker_t  ctx[N_THREADS];
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    for (int i = 0; i < N_THREADS; i++) {
        ctx[i].id = i;
        ctx[i].pkts = ctx[i].bytes = 0;
        pthread_create(&tids[i], NULL, worker, &ctx[i]);
    }

    struct timespec dur = { DURATION_SEC, 0 };
    clock_nanosleep(CLOCK_MONOTONIC, 0, &dur, NULL);
    atomic_store_explicit(&g_run, 0, memory_order_relaxed);

    for (int i = 0; i < N_THREADS; i++)
        pthread_join(tids[i], NULL);

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double elapsed = (double)(t1.tv_sec - t0.tv_sec)
                   + (double)(t1.tv_nsec - t0.tv_nsec) * 1e-9;

    uint64_t sum_p = 0, sum_b = 0;
    for (int i = 0; i < N_THREADS; i++) {
        printf("  thread %d: %10" PRIu64 " pkts  %14" PRIu64 " bytes\n",
               i, ctx[i].pkts, ctx[i].bytes);
        sum_p += ctx[i].pkts;
        sum_b += ctx[i].bytes;
    }

    double actual_pps = (double)sum_p / elapsed;
    double actual_bps = (double)sum_b / elapsed;

    double eff_pps = pps_cap;
    double bps_pps = bps_cap / PKT_SIZE;
    const char *binding = "pps";
    if (bps_pps < eff_pps) { eff_pps = bps_pps; binding = "bps"; }
    double eff_bps = eff_pps * PKT_SIZE;

    printf("\nresults (%.2fs elapsed):\n", elapsed);
    printf("  packets: %10" PRIu64 "  %.0f pps  (effective cap %.0f, %.1f%%)\n",
           sum_p, actual_pps, eff_pps, actual_pps / eff_pps * 100.0);
    printf("  bytes:   %10" PRIu64 "  %.0f Bps  (effective cap %.0f, %.1f%%)\n",
           sum_b, actual_bps, eff_bps, actual_bps / eff_bps * 100.0);
    printf("  binding limit: %s\n", binding);

    rate_limiter_destroy(&g_rl);
    return 0;
}
