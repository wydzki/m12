/*
 * m12 — minimal mbedTLS 3.6.x build config for the MIPS telemetry agent.
 *
 * This file REPLACES mbedTLS's default config (it is a full MBEDTLS_CONFIG_FILE,
 * not a patch). It enables ONLY what the agent's single use case needs:
 *
 *     TLS 1.2 client, mutual-auth, ECDHE-ECDSA-AES128-GCM-SHA256, curve P-256,
 *     PEM cert/key files loaded from disk, server cert verified against a CA.
 *
 * Everything else the stock build drags in — TLS 1.3, RSA, DHE, PSK, CBC/CCM/
 * ChaCha20, ARIA/Camellia/3DES, SHA-1/MD5/SHA-512, every curve but P-256, the
 * error-string tables, self-tests — is left out. That is where the ~800 KB
 * comes from; trimmed, the whole static agent is typically ~200 KB or less.
 *
 * Build it via:  make MINIMAL_TLS=1
 * (the Makefile passes -DMBEDTLS_CONFIG_FILE for BOTH the library and the agent,
 *  so their struct layouts match — never define it for only one).
 *
 * If `make` stops with an #error from mbedtls/check_config.h, it is telling you
 * a required dependency is missing here — enable exactly what it names and
 * rebuild. (Starting point if you'd rather not hand-trim: the tarball ships
 * configs/config-suite-b.h, which also compiles; this file is more aggressive —
 * P-256 + AES-128 only, no P-384/AES-256.)
 *
 * ASSUMPTIONS about your PKI (from scripts/pki.sh): EC P-256 keys, SHA-256
 * signatures, unencrypted PEM private keys. If your certs are RSA or SHA-1
 * signed, or your key is encrypted, you must re-enable the matching modules
 * below (RSA_C / SHA1_C / PKCS5_C+PKCS12_C) or the handshake/parse will fail.
 */
#ifndef MBEDTLS_CONFIG_MIN_H
#define MBEDTLS_CONFIG_MIN_H

/* ---- system / platform ---- */
#define MBEDTLS_HAVE_ASM
#define MBEDTLS_HAVE_TIME            /* cert validity needs a clock          */
#define MBEDTLS_HAVE_TIME_DATE       /* ...and notBefore/notAfter checking   */
#define MBEDTLS_FS_IO                /* x509_crt_parse_file / pk_parse_keyfile */
#define MBEDTLS_NET_C                /* mbedtls/net_sockets.h                 */

/* ---- RNG / entropy (Linux reads /dev/urandom) ---- */
#define MBEDTLS_ENTROPY_C
#define MBEDTLS_CTR_DRBG_C

/* ---- symmetric: AES-128-GCM only ---- */
#define MBEDTLS_AES_C
#define MBEDTLS_GCM_C
#define MBEDTLS_CIPHER_C

/* ---- hash: SHA-256 only (PRF, HMAC, cert sigs, entropy accumulator) ---- */
#define MBEDTLS_MD_C
#define MBEDTLS_SHA224_C             /* paired with SHA256 in the SHA-256 module */
#define MBEDTLS_SHA256_C

/* ---- public key: EC only, P-256 only ---- */
#define MBEDTLS_BIGNUM_C
#define MBEDTLS_ECP_C
#define MBEDTLS_ECP_DP_SECP256R1_ENABLED
#define MBEDTLS_ECDH_C
#define MBEDTLS_ECDSA_C
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_ASN1_WRITE_C
#define MBEDTLS_OID_C
#define MBEDTLS_PK_C
#define MBEDTLS_PK_PARSE_C
#define MBEDTLS_BASE64_C
#define MBEDTLS_PEM_PARSE_C          /* PEM ca.crt / node.crt / node.key      */

/* ---- X.509: parse+verify a server cert chain, present our own ---- */
#define MBEDTLS_X509_USE_C
#define MBEDTLS_X509_CRT_PARSE_C

/* ---- TLS: 1.2 client, one key exchange ---- */
#define MBEDTLS_SSL_TLS_C
#define MBEDTLS_SSL_CLI_C
#define MBEDTLS_SSL_PROTO_TLS1_2
#define MBEDTLS_KEY_EXCHANGE_ECDHE_ECDSA_ENABLED
#define MBEDTLS_SSL_KEEP_PEER_CERTIFICATE

/* Keep mbedtls_strerror() linkable without the multi-KB string tables that
 * MBEDTLS_ERROR_C would pull in (the agent calls it in emit_err()). */
#define MBEDTLS_ERROR_STRERROR_DUMMY

/* ---- size tuning ---- */
#define MBEDTLS_SSL_IN_CONTENT_LEN   4096   /* tiny payloads; default is 16 KB */
#define MBEDTLS_SSL_OUT_CONTENT_LEN  4096
#define MBEDTLS_AES_ONLY_128_BIT_KEY_LENGTH /* drop AES-192/256 code + tables  */
#define MBEDTLS_AES_FEWER_TABLES            /* smaller AES tables, slightly slower */
#define MBEDTLS_SHA256_SMALLER              /* smaller SHA-256 core            */
#define MBEDTLS_ECP_NIST_OPTIM              /* compact + fast for NIST curves  */
#define MBEDTLS_ECP_WINDOW_SIZE      2      /* smallest precompute window      */
#define MBEDTLS_ECP_FIXED_POINT_OPTIM 0     /* drop the large fixed-point table */

#include "mbedtls/check_config.h"

#endif /* MBEDTLS_CONFIG_MIN_H */
