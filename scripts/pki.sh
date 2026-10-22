#!/usr/bin/env bash
# m12 private PKI helper (openssl, EC P-256 — light on MIPS CPUs).
#
#   ./scripts/pki.sh init-ca                 create the node CA (do this once)
#   ./scripts/pki.sh server-cert <hostname>  cert for the ingest listener
#   ./scripts/pki.sh node-cert   <node-id>   client cert for one node
#   ./scripts/pki.sh revoke      <node-id>   add a node to the revocation list
#
# Output goes to $PKI_DIR (default ./pki). Keep ca.key and every *.key secret.
set -euo pipefail

# Stop MSYS/Git-Bash on Windows from rewriting "/CN=..." into a filesystem path.
# Harmless on Linux/macOS (the vars are simply ignored).
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

PKI_DIR="${PKI_DIR:-pki}"
CA_DAYS="${CA_DAYS:-3650}"      # CA valid 10 years
LEAF_DAYS="${LEAF_DAYS:-825}"   # leaf certs valid ~27 months
CURVE=prime256v1

mkdir -p "$PKI_DIR"
umask 077   # new key files are 0600

ca_key="$PKI_DIR/ca.key"
ca_crt="$PKI_DIR/ca.crt"
revoked="$PKI_DIR/revoked.txt"

die() { echo "error: $*" >&2; exit 1; }
need_ca() { [ -f "$ca_key" ] && [ -f "$ca_crt" ] || die "no CA yet — run: $0 init-ca"; }

case "${1:-}" in
  init-ca)
    [ -f "$ca_key" ] && die "CA already exists at $ca_key (refusing to overwrite)"
    openssl ecparam -name "$CURVE" -genkey -noout -out "$ca_key"
    openssl req -x509 -new -key "$ca_key" -sha256 -days "$CA_DAYS" -out "$ca_crt" \
      -subj "/CN=m12 Node CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign"
    echo "# m12 revoked certificates — one node-id or cert serial per line" > "$revoked"
    echo "CA created:"
    echo "  $ca_crt   (give this to the server AND every node)"
    echo "  $ca_key   (SECRET — keep offline if you can)"
    ;;

  server-cert)
    need_ca
    host="${2:-}"; [ -n "$host" ] || die "usage: $0 server-cert <hostname-or-ip>"
    key="$PKI_DIR/server.key"; crt="$PKI_DIR/server.crt"; csr="$PKI_DIR/.server.csr"; ext="$PKI_DIR/.server.ext"
    trap 'rm -f "$csr" "$ext"' EXIT
    if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then san="IP:$host"; else san="DNS:$host"; fi
    openssl ecparam -name "$CURVE" -genkey -noout -out "$key"
    openssl req -new -key "$key" -subj "/CN=$host" -out "$csr"
    cat > "$ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF
    openssl x509 -req -in "$csr" -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
      -sha256 -days "$LEAF_DAYS" -extfile "$ext" -out "$crt"
    echo "server cert for '$host':"
    echo "  INGEST_CERT_FILE=$crt"
    echo "  INGEST_KEY_FILE=$key"
    echo "  INGEST_CA_FILE=$ca_crt"
    ;;

  node-cert)
    need_ca
    node="${2:-}"
    [[ "$node" =~ ^[a-z][a-z0-9-]{1,63}$ ]] || die "node id must match ^[a-z][a-z0-9-]{1,63}$ (e.g. node-mips-0007)"
    key="$PKI_DIR/$node.key"; crt="$PKI_DIR/$node.crt"; csr="$PKI_DIR/.$node.csr"; ext="$PKI_DIR/.$node.ext"
    trap 'rm -f "$csr" "$ext"' EXIT
    [ -f "$crt" ] && die "$crt already exists"
    cat > "$ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF
    openssl ecparam -name "$CURVE" -genkey -noout -out "$key"
    openssl req -new -key "$key" -subj "/CN=$node" -out "$csr"
    openssl x509 -req -in "$csr" -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
      -sha256 -days "$LEAF_DAYS" -extfile "$ext" -out "$crt"
    echo "node cert for '$node':"
    echo "  copy to the node:  $crt  $key  $ca_crt"
    echo "  serial: $(openssl x509 -in "$crt" -noout -serial | cut -d= -f2)"
    ;;

  revoke)
    need_ca
    node="${2:-}"; [ -n "$node" ] || die "usage: $0 revoke <node-id>"
    grep -qxF "$node" "$revoked" 2>/dev/null || echo "$node" >> "$revoked"
    echo "revoked '$node'. Point INGEST_REVOKED_FILE at $revoked (takes effect within one request, no restart)."
    ;;

  *)
    sed -n '2,12p' "$0"; exit 1 ;;
esac
