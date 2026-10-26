#ifndef UDP_SENDER_H
#define UDP_SENDER_H

#include <stddef.h>
#include <stdint.h>
#include <netinet/in.h>
#include "rate_limiter.h"

typedef struct {
    int fd;
    struct sockaddr_in dst;
} udp_sender_t;

typedef struct {
    uint64_t packets;
    uint64_t bytes;
} udp_stats_t;

/*
 * Open a UDP socket targeted at ip:port.
 * Returns 0 on success, -1 on failure.
 */
int  udp_sender_init(udp_sender_t *s, const char *ip, uint16_t port);

/*
 * One sendto(). Returns bytes sent or -1.
 * No retry, no logging — caller decides.
 */
int  udp_send(udp_sender_t *s, const void *payload, size_t len);

/*
 * Rate-limited send loop: acquire tokens, sendto, repeat until
 * duration_sec elapses (CLOCK_MONOTONIC). Returns packet/byte counts.
 */
udp_stats_t udp_sender_run(udp_sender_t *s, rate_limiter_t *rl,
                            const void *payload, size_t payload_len,
                            double duration_sec);

void udp_sender_destroy(udp_sender_t *s);

/*
 * Fill buf with a deterministic repeating pattern (not random —
 * reproducible, but not compressible zeros either).
 */
void udp_build_payload(void *buf, size_t size);

#endif
