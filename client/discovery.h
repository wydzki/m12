#ifndef DISCOVERY_H
#define DISCOVERY_H

#include <stdint.h>
#include <stddef.h>

#define DISC_MAX_PORTS   64
#define DISC_MAX_RESULTS 4096

typedef struct {
    uint32_t ip;   /* network byte order */
    uint16_t port;
} disc_result_t;

typedef struct {
    disc_result_t hits[DISC_MAX_RESULTS];
    int count;
    int scanned;
} disc_report_t;

/*
 * Scan every ip in [start_ip, end_ip] on each port in ports[].
 * timeout_ms is the per-connection timeout. Results written to report.
 * Returns 0 on success, -1 on bad input.
 */
int discovery_scan(const char *start_ip, const char *end_ip,
                   const uint16_t *ports, int nports,
                   int timeout_ms, disc_report_t *report);

/* Format report as a human-readable string into dst (cap bytes). */
int discovery_format(const disc_report_t *r, char *dst, size_t cap);

#endif
