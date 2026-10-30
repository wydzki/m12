#ifndef TCP_SENDER_H
#define TCP_SENDER_H

#include <stddef.h>
#include <stdint.h>
#include "rate_limiter.h"

typedef struct {
    uint64_t bytes;
    uint64_t writes;
    uint64_t err_eagain;
    uint64_t err_connreset;
    uint64_t err_pipe;
    uint64_t err_other;
    uint32_t retransmits;
    uint32_t rtt_us;
    uint32_t rttvar_us;
    uint32_t min_rtt_us;
    uint32_t max_rtt_us;
} tcp_stats_t;

/*
 * Open a TCP connection to ip:port.
 * Returns the fd on success, -1 on failure.
 */
int tcp_sender_connect(const char *ip, uint16_t port, uint16_t src_port);

/*
 * Rate-limited write loop: acquire tokens, write, repeat until
 * duration_sec elapses. Returns byte/write counts.
 */
tcp_stats_t tcp_sender_run(int fd, rate_limiter_t *rl,
                           const void *payload, size_t payload_len,
                           double duration_sec);

#endif
