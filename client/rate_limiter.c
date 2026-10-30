/*
 * Dual token-bucket rate limiter — packets/sec + bytes/sec, thread-safe.
 *
 * Thread-safety approach: mutex around the bucket arithmetic, sleep outside.
 *
 * The mutex protects only the refill-check-consume sequence — a clock_gettime,
 * two multiplies, two compares, and two subtracts.  That critical section is
 * ~60-100ns on modern hardware (futex fast path for the lock, vDSO for the
 * clock).  The actual wait, when tokens are exhausted, happens OUTSIDE the
 * lock via clock_nanosleep, so sleeping threads never block other threads
 * from checking or consuming tokens.
 *
 * Why not lock-free CAS?  The operation consumes from two independent buckets
 * atomically — one packet token AND N byte tokens.  A CAS loop on one bucket
 * can succeed while the other fails, requiring rollback (atomic_fetch_add to
 * return the token).  That rollback window creates a brief under-count that
 * can cause a peer thread to compute a longer sleep than necessary — not a
 * correctness bug, but a throughput hiccup under contention that's harder to
 * reason about than a simple mutex.  The mutex critical section is short
 * enough (~100ns) that at 1M acquires/sec across 4 threads the total lock
 * hold time is ~400ms/sec — well under saturation, and the futex fast path
 * keeps uncontended lock/unlock at ~25ns.  The mutex is not the bottleneck;
 * the rate limiter's job is to be the bottleneck.
 */
#define _POSIX_C_SOURCE 200112L
#include "rate_limiter.h"
#include <stdio.h>

static inline double ts_sec(const struct timespec *ts)
{
    return (double)ts->tv_sec + (double)ts->tv_nsec * 1e-9;
}

static void refill(rate_limiter_t *rl)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    double dt = ts_sec(&now) - ts_sec(&rl->last);
    if (dt <= 0.0) return;
    rl->last = now;
    rl->pkt_tokens  += dt * rl->pkt_rate;
    rl->byte_tokens += dt * rl->byte_rate;
    if (rl->pkt_tokens  > rl->pkt_burst)  rl->pkt_tokens  = rl->pkt_burst;
    if (rl->byte_tokens > rl->byte_burst) rl->byte_tokens = rl->byte_burst;
}

int rate_limiter_init(rate_limiter_t *rl,
                      double pps_cap, double bps_cap,
                      double burst_pps, double burst_bps)
{
    if (pthread_mutex_init(&rl->mtx, NULL) != 0) return -1;
    rl->pkt_rate   = pps_cap;
    rl->byte_rate  = bps_cap;
    rl->pkt_burst  = burst_pps;
    rl->byte_burst = burst_bps;
    rl->pkt_tokens  = burst_pps;
    rl->byte_tokens = burst_bps;
    clock_gettime(CLOCK_MONOTONIC, &rl->last);
    return 0;
}

void rate_limiter_acquire(rate_limiter_t *rl, size_t n_bytes)
{
    double need = (double)n_bytes;
    for (;;) {
        pthread_mutex_lock(&rl->mtx);
        refill(rl);
        if (need > rl->byte_burst) {
            fprintf(stderr, "rate_limiter: burst_bps raised: %.0f -> %zu (packet size %zu)\n",
                    rl->byte_burst, n_bytes, n_bytes);
            rl->byte_burst = need;
        }

        if (rl->pkt_tokens >= 1.0 && rl->byte_tokens >= need) {
            rl->pkt_tokens  -= 1.0;
            rl->byte_tokens -= need;
            pthread_mutex_unlock(&rl->mtx);
            return;
        }

        /* Exact sleep: time until whichever bucket is shorter catches up. */
        double pw = rl->pkt_tokens  >= 1.0  ? 0.0
                  : (1.0  - rl->pkt_tokens)  / rl->pkt_rate;
        double bw = rl->byte_tokens >= need  ? 0.0
                  : (need - rl->byte_tokens) / rl->byte_rate;
        double wait = pw > bw ? pw : bw;
        if (wait < 1e-6) wait = 1e-6;        /* 1µs floor to avoid spinning */

        struct timespec target;
        clock_gettime(CLOCK_MONOTONIC, &target);
        double t = ts_sec(&target) + wait;
        target.tv_sec  = (time_t)t;
        target.tv_nsec = (long)((t - (double)target.tv_sec) * 1e9);

        pthread_mutex_unlock(&rl->mtx);       /* release BEFORE sleeping */
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &target, NULL);
    }
}

void rate_limiter_set_rates(rate_limiter_t *rl, double pps, double bps)
{
    pthread_mutex_lock(&rl->mtx);
    refill(rl);
    rl->pkt_rate   = pps;
    rl->byte_rate  = bps;
    rl->pkt_burst  = pps * 0.1;
    rl->byte_burst = bps * 0.1;
    if (rl->pkt_burst  < 1.0)    rl->pkt_burst  = 1.0;
    if (rl->byte_burst < 1500.0) rl->byte_burst = 1500.0;
    if (rl->pkt_tokens  > rl->pkt_burst)  rl->pkt_tokens  = rl->pkt_burst;
    if (rl->byte_tokens > rl->byte_burst) rl->byte_tokens = rl->byte_burst;
    pthread_mutex_unlock(&rl->mtx);
}

void rate_limiter_destroy(rate_limiter_t *rl)
{
    pthread_mutex_destroy(&rl->mtx);
}
