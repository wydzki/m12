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
#define _GNU_SOURCE
#include "udp_sender.h"
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <stdatomic.h>

#ifdef __linux__
#include <sys/uio.h>
#define BATCH_SIZE 64
#endif

static _Atomic uint64_t g_udp_seq = 0;

static inline void put_be64(unsigned char *p, uint64_t v) {
    p[0] = (v >> 56) & 0xFF;
    p[1] = (v >> 48) & 0xFF;
    p[2] = (v >> 40) & 0xFF;
    p[3] = (v >> 32) & 0xFF;
    p[4] = (v >> 24) & 0xFF;
    p[5] = (v >> 16) & 0xFF;
    p[6] = (v >>  8) & 0xFF;
    p[7] =  v        & 0xFF;
}

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

static void build_pkt(unsigned char *dst, const void *payload, size_t payload_len,
                      int use_seq, int vary_payload) {
    if (use_seq && payload_len >= 8) {
        uint64_t seq = atomic_fetch_add_explicit(&g_udp_seq, 1, memory_order_relaxed);
        if (vary_payload) {
            put_be64(dst, seq);
            unsigned char mix = (unsigned char)(((uint32_t)seq * 0x9E3779B9u) >> 24);
            const unsigned char *base = (const unsigned char *)payload;
            for (size_t i = 8; i < payload_len; i++)
                dst[i] = base[i] ^ mix ^ (unsigned char)(seq + i);
        } else {
            memcpy(dst, payload, payload_len);
            put_be64(dst, seq);
        }
    } else {
        memcpy(dst, payload, payload_len);
    }
}

#ifdef __linux__
static int flush_batch(int fd, struct sockaddr_in *dst,
                       struct mmsghdr *msgs, struct iovec *iovs, int count) {
    for (int i = 0; i < count; i++) {
        msgs[i].msg_hdr.msg_name = dst;
        msgs[i].msg_hdr.msg_namelen = sizeof(*dst);
        msgs[i].msg_hdr.msg_iov = &iovs[i];
        msgs[i].msg_hdr.msg_iovlen = 1;
        msgs[i].msg_hdr.msg_control = NULL;
        msgs[i].msg_hdr.msg_controllen = 0;
        msgs[i].msg_hdr.msg_flags = 0;
        msgs[i].msg_len = 0;
    }
    int sent = sendmmsg(fd, msgs, count, 0);
    return sent > 0 ? sent : 0;
}
#endif

udp_stats_t udp_sender_run(udp_sender_t *s, rate_limiter_t *rl,
                            void *payload, size_t payload_len,
                            double duration_sec, int use_seq,
                            int vary_payload)
{
    udp_stats_t st = {0};
    struct timespec t0, now;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    double deadline = (double)t0.tv_sec + (double)t0.tv_nsec * 1e-9
                    + duration_sec;

    if (payload_len > 1400) payload_len = 1400;

    int consec_err = 0;
    uint64_t ew_start = 0, ew_errs = 0, ew_ops = 0;

#ifdef __linux__
    unsigned char pktbufs[BATCH_SIZE][1400];
    struct mmsghdr msgs[BATCH_SIZE];
    struct iovec iovs[BATCH_SIZE];
    int batch_idx = 0;

    for (;;) {
        rate_limiter_acquire(rl, payload_len);
        build_pkt(pktbufs[batch_idx], payload, payload_len, use_seq, vary_payload);
        iovs[batch_idx].iov_base = pktbufs[batch_idx];
        iovs[batch_idx].iov_len = payload_len;
        batch_idx++;

        int do_flush = (batch_idx >= BATCH_SIZE);
        if (!do_flush) {
            clock_gettime(CLOCK_MONOTONIC, &now);
            double t = (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
            if (t >= deadline) do_flush = 1;
        }
        if (do_flush) {
            int sent = flush_batch(s->fd, &s->dst, msgs, iovs, batch_idx);
            ew_ops += (uint64_t)batch_idx;
            if (sent > 0) consec_err = 0;
            for (int i = 0; i < sent; i++) {
                st.packets++;
                st.bytes += msgs[i].msg_len;
            }
            for (int i = sent; i < batch_idx; i++) {
                if (errno == EAGAIN || errno == EWOULDBLOCK) { st.err_eagain++; continue; }
                consec_err++;
                ew_errs++;
                if (!st.first_err_ns && consec_err >= 3) {
                    struct timespec fe; clock_gettime(CLOCK_MONOTONIC, &fe);
                    st.first_err_ns = (uint64_t)fe.tv_sec * 1000000000ULL + (uint64_t)fe.tv_nsec;
                }
                if (errno == ECONNREFUSED) st.err_connrefused++;
                else if (errno == ENOBUFS) st.err_enobufs++;
                else if (errno == EMSGSIZE) st.err_emsgsize++;
                else if (errno == EHOSTUNREACH) st.err_ehostunreach++;
                else if (errno == EACCES) st.err_eacces++;
                else if (errno == EPERM) st.err_eperm++;
                else if (errno == ENETUNREACH) st.err_enetunreach++;
                else { if (!st.first_other_errno) st.first_other_errno = errno; st.err_other++; }
            }
            batch_idx = 0;
            clock_gettime(CLOCK_MONOTONIC, &now);
            double t = (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
            if (!st.first_err_ns && ew_ops > 0) {
                uint64_t now_ns = (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
                if (!ew_start) ew_start = now_ns;
                else if (now_ns - ew_start >= 1000000000ULL) {
                    if (ew_errs * 100 > ew_ops)
                        st.first_err_ns = now_ns;
                    ew_start = now_ns;
                    ew_errs = 0;
                    ew_ops = 0;
                }
            }
            if (t >= deadline) break;
        }
    }
#else
    for (;;) {
        unsigned char pkt[1400];
        rate_limiter_acquire(rl, payload_len);
        build_pkt(pkt, payload, payload_len, use_seq, vary_payload);
        int sent = udp_send(s, pkt, payload_len);
        ew_ops++;
        if (sent > 0) {
            st.packets++;
            st.bytes += (uint64_t)sent;
            consec_err = 0;
        } else if (sent < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) { st.err_eagain++; }
            else {
                consec_err++;
                ew_errs++;
                if (!st.first_err_ns && consec_err >= 3) {
                    struct timespec fe; clock_gettime(CLOCK_MONOTONIC, &fe);
                    st.first_err_ns = (uint64_t)fe.tv_sec * 1000000000ULL + (uint64_t)fe.tv_nsec;
                }
                if (errno == ECONNREFUSED) st.err_connrefused++;
                else if (errno == ENOBUFS) st.err_enobufs++;
                else if (errno == EMSGSIZE) st.err_emsgsize++;
                else if (errno == EHOSTUNREACH) st.err_ehostunreach++;
                else if (errno == EACCES) st.err_eacces++;
                else if (errno == EPERM) st.err_eperm++;
                else if (errno == ENETUNREACH) st.err_enetunreach++;
                else { if (!st.first_other_errno) st.first_other_errno = errno; st.err_other++; }
            }
        }
        clock_gettime(CLOCK_MONOTONIC, &now);
        double t = (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
        if (!st.first_err_ns && ew_ops > 0) {
            uint64_t now_ns = (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
            if (!ew_start) ew_start = now_ns;
            else if (now_ns - ew_start >= 1000000000ULL) {
                if (ew_errs * 100 > ew_ops)
                    st.first_err_ns = now_ns;
                ew_start = now_ns;
                ew_errs = 0;
                ew_ops = 0;
            }
        }
        if (t >= deadline) break;
    }
#endif
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
