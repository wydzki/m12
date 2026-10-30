#ifndef RATE_LIMITER_H
#define RATE_LIMITER_H

#include <stddef.h>
#include <pthread.h>
#include <time.h>

typedef struct {
    pthread_mutex_t mtx;
    double pkt_rate;       /* sustained packets/sec refill  */
    double byte_rate;      /* sustained bytes/sec refill    */
    double pkt_burst;      /* max accumulated packet tokens */
    double byte_burst;     /* max accumulated byte tokens   */
    double pkt_tokens;     /* current packet tokens         */
    double byte_tokens;    /* current byte tokens           */
    struct timespec last;  /* last refill timestamp          */
} rate_limiter_t;

/*
 * Initialize the limiter. Buckets start full (at burst capacity).
 * burst_pps/burst_bps cap how many tokens accumulate during idle —
 * a short idle lets the next burst go out at line rate up to the ceiling.
 * Returns 0 on success, -1 on failure.
 */
int  rate_limiter_init(rate_limiter_t *rl,
                       double pps_cap, double bps_cap,
                       double burst_pps, double burst_bps);

/*
 * Block until 1 packet token and n_bytes byte tokens are available,
 * then consume them and return. Waits are computed sleeps on
 * CLOCK_MONOTONIC, not fixed-interval polls.
 *
 * n_bytes must not exceed byte_burst, or the call blocks forever.
 */
void rate_limiter_acquire(rate_limiter_t *rl, size_t n_bytes);

void rate_limiter_set_rates(rate_limiter_t *rl, double pps, double bps);

void rate_limiter_destroy(rate_limiter_t *rl);

#endif
