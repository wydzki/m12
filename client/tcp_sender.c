#define _POSIX_C_SOURCE 200112L
#include "tcp_sender.h"
#include <sys/socket.h>
#include <sys/time.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <unistd.h>
#include <string.h>
#include <time.h>
#include <errno.h>

int tcp_sender_connect(const char *ip, uint16_t port, uint16_t src_port)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    if (src_port) {
        int reuse = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        struct sockaddr_in ba;
        memset(&ba, 0, sizeof(ba));
        ba.sin_family = AF_INET;
        ba.sin_port = htons(src_port);
        ba.sin_addr.s_addr = INADDR_ANY;
        bind(fd, (struct sockaddr *)&ba, sizeof(ba));
    }

    struct sockaddr_in sa;
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_port = htons(port);
    if (inet_pton(AF_INET, ip, &sa.sin_addr) != 1) {
        close(fd);
        return -1;
    }
    if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
        close(fd);
        return -1;
    }

    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    return fd;
}

tcp_stats_t tcp_sender_run(int fd, rate_limiter_t *rl,
                           const void *payload, size_t payload_len,
                           double duration_sec)
{
    tcp_stats_t st = {0};
    struct timespec t0, now;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    double deadline = (double)t0.tv_sec + (double)t0.tv_nsec * 1e-9
                    + duration_sec;

    for (;;) {
        rate_limiter_acquire(rl, payload_len);
        ssize_t n = send(fd, payload, payload_len, MSG_NOSIGNAL);
        if (n > 0) {
            st.writes++;
            st.bytes += (uint64_t)n;
        } else if (n < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                st.err_eagain++;
                struct pollfd pfd = { .fd = fd, .events = POLLOUT };
                poll(&pfd, 1, 100);
                continue;
            }
            if (errno == ECONNRESET) { st.err_connreset++; break; }
            if (errno == EPIPE)      { st.err_pipe++;      break; }
            st.err_other++;
            break;
        }
        clock_gettime(CLOCK_MONOTONIC, &now);
        double t = (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
        if (t >= deadline) break;
    }

    struct tcp_info ti;
    memset(&ti, 0, sizeof(ti));
    socklen_t tilen = sizeof(ti);
    if (getsockopt(fd, IPPROTO_TCP, TCP_INFO, &ti, &tilen) == 0) {
        st.retransmits = ti.tcpi_total_retrans;
        st.rtt_us      = ti.tcpi_rtt;
        st.rttvar_us   = ti.tcpi_rttvar;
        st.min_rtt_us  = ti.tcpi_rtt > ti.tcpi_rttvar ? ti.tcpi_rtt - ti.tcpi_rttvar : ti.tcpi_rtt;
        st.max_rtt_us  = ti.tcpi_rtt + ti.tcpi_rttvar * 4;
    }

    shutdown(fd, SHUT_WR);
    char drain[512];
    struct timeval tv = { .tv_sec = 2, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    while (recv(fd, drain, sizeof(drain), 0) > 0) {}
    return st;
}
