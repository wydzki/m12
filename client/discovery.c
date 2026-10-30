#define _POSIX_C_SOURCE 200112L
#include "discovery.h"
#include <sys/socket.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>

static int try_connect(uint32_t ip, uint16_t port, int timeout_ms)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    struct sockaddr_in sa;
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = ip;
    sa.sin_port = htons(port);

    int rc = connect(fd, (struct sockaddr *)&sa, sizeof(sa));
    if (rc == 0) { close(fd); return 1; }
    if (errno != EINPROGRESS) { close(fd); return 0; }

    struct pollfd pfd = { .fd = fd, .events = POLLOUT };
    rc = poll(&pfd, 1, timeout_ms);
    if (rc <= 0) { close(fd); return 0; }
    if (pfd.revents & (POLLERR | POLLHUP)) { close(fd); return 0; }

    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0) { close(fd); return 0; }
    close(fd);
    return err == 0 ? 1 : 0;
}

int discovery_scan(const char *start_ip, const char *end_ip,
                   const uint16_t *ports, int nports,
                   int timeout_ms, disc_report_t *report)
{
    struct in_addr sa, ea;
    if (inet_pton(AF_INET, start_ip, &sa) != 1) return -1;
    if (inet_pton(AF_INET, end_ip, &ea) != 1) return -1;

    uint32_t start = ntohl(sa.s_addr);
    uint32_t end   = ntohl(ea.s_addr);
    if (start > end) return -1;
    if (nports <= 0 || nports > DISC_MAX_PORTS) return -1;
    if (timeout_ms <= 0) timeout_ms = 1000;

    report->count = 0;
    report->scanned = 0;

    for (uint32_t ip = start; ip <= end; ip++) {
        uint32_t net_ip = htonl(ip);
        for (int p = 0; p < nports; p++) {
            report->scanned++;
            if (try_connect(net_ip, ports[p], timeout_ms) == 1) {
                if (report->count < DISC_MAX_RESULTS) {
                    report->hits[report->count].ip = net_ip;
                    report->hits[report->count].port = ports[p];
                    report->count++;
                }
            }
        }
    }
    return 0;
}

int discovery_format(const disc_report_t *r, char *dst, size_t cap)
{
    int off = snprintf(dst, cap, "scanned=%d open=%d\n", r->scanned, r->count);
    for (int i = 0; i < r->count && (size_t)off < cap - 40; i++) {
        char ipbuf[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &r->hits[i].ip, ipbuf, sizeof(ipbuf));
        off += snprintf(dst + off, cap - off, "%s:%d\n", ipbuf, r->hits[i].port);
    }
    return off;
}
