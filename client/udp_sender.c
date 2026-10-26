/*
 * UDP datagram sender — pairs with rate_limiter for paced sends.
 *
 * Send-path critical section (between rate_limiter_acquire and sendto):
 * Nothing. The acquire blocks until tokens are available, then returns.
 * The very next instruction is sendto(). There is no lock, no allocation,
 * no logging, no branch between the two calls. This matters because any
 * work inserted between acquire and send inflates the gap between "tokens
 * consumed" and "packet actually on the wire," which makes the limiter's
 * pacing less accurate — tokens are debited but the wire is idle. The
 * send function itself is a single syscall on a connected-address socket
 * (the kernel resolves the route once at connect time, not per-send).
 */
#define _POSIX_C_SOURCE 200112L
#include "udp_sender.h"
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <string.h>
#include <time.h>

int udp_sender_init(udp_sender_t *s, const char *ip, uint16_t port)
{
    s->fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (s->fd < 0) return -1;

    memset(&s->dst, 0, sizeof(s->dst));
    s->dst.sin_family = AF_INET;
    s->dst.sin_port   = htons(port);
    if (inet_pton(AF_INET, ip, &s->dst.sin_addr) != 1) {
        close(s->fd);
        s->fd = -1;
        return -1;
    }
    return 0;
}

int udp_send(udp_sender_t *s, const void *payload, size_t len)
{
    ssize_t n = sendto(s->fd, payload, len, 0,
                       (struct sockaddr *)&s->dst, sizeof(s->dst));
    return n >= 0 ? (int)n : -1;
}

udp_stats_t udp_sender_run(udp_sender_t *s, rate_limiter_t *rl,
                            const void *payload, size_t payload_len,
                            double duration_sec)
{
    udp_stats_t st = { 0, 0 };
    struct timespec t0, now;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    double deadline = (double)t0.tv_sec + (double)t0.tv_nsec * 1e-9
                    + duration_sec;

    for (;;) {
        rate_limiter_acquire(rl, payload_len);
        /* — nothing between acquire and send — */
        int sent = udp_send(s, payload, payload_len);
        if (sent > 0) {
            st.packets++;
            st.bytes += (uint64_t)sent;
        }
        clock_gettime(CLOCK_MONOTONIC, &now);
        double t = (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
        if (t >= deadline) break;
    }
    return st;
}

void udp_sender_destroy(udp_sender_t *s)
{
    if (s->fd >= 0) { close(s->fd); s->fd = -1; }
}

void udp_build_payload(void *buf, size_t size)
{
    unsigned char *p = buf;
    for (size_t i = 0; i < size; i++)
        p[i] = (unsigned char)(0xA5 ^ (i & 0xFF));
}
