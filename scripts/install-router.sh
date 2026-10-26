#!/bin/sh
# Install m12-agent on an OpenWrt / busybox router.
#
# Usage (run ON the router):
#   sh install-router.sh m12-agent-mipsel
#   sh install-router.sh m12-agent-mips
#
# What it does:
#   1. Copies the binary to /usr/bin/m12-agent
#   2. Creates a watchdog script that restarts the agent if it dies
#   3. Adds it to /etc/rc.local so it survives reboots
#   4. Starts it immediately

BIN="${1:-m12-agent-mipsel}"

if [ ! -f "$BIN" ]; then
  echo "error: $BIN not found"
  echo "usage: sh install-router.sh <binary>"
  exit 1
fi

INSTALL_DIR="/usr/bin"
AGENT="$INSTALL_DIR/m12-agent"
WATCHDOG="/usr/bin/m12-watchdog"
PIDFILE="/tmp/m12-agent.pid"

echo "[+] installing $BIN -> $AGENT"
cp "$BIN" "$AGENT"
chmod +x "$AGENT"

echo "[+] creating watchdog at $WATCHDOG"
cat > "$WATCHDOG" << 'WATCHDOG_EOF'
#!/bin/sh
PIDFILE="/tmp/m12-agent.pid"
AGENT="/usr/bin/m12-agent"
LOGFILE="/tmp/m12-agent.log"

# kill any existing instance
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null
  rm -f "$PIDFILE"
fi

while true; do
  echo "$(date): starting m12-agent" >> "$LOGFILE"
  $AGENT >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  wait $!
  echo "$(date): m12-agent exited ($?), restarting in 10s" >> "$LOGFILE"
  rm -f "$PIDFILE"
  sleep 10
done
WATCHDOG_EOF
chmod +x "$WATCHDOG"

# add to rc.local if not already there
RCLOCAL="/etc/rc.local"
if [ -f "$RCLOCAL" ]; then
  if ! grep -q "m12-watchdog" "$RCLOCAL"; then
    echo "[+] adding to $RCLOCAL"
    # insert before 'exit 0' if present, otherwise append
    if grep -q "^exit 0" "$RCLOCAL"; then
      sed -i "/^exit 0/i $WATCHDOG &" "$RCLOCAL"
    else
      echo "$WATCHDOG &" >> "$RCLOCAL"
    fi
  else
    echo "[=] already in $RCLOCAL"
  fi
else
  echo "$WATCHDOG &" > "$RCLOCAL"
  chmod +x "$RCLOCAL"
fi

# stop any running instance and start fresh
echo "[+] starting agent"
killall m12-agent 2>/dev/null
killall m12-watchdog 2>/dev/null
sleep 1
$WATCHDOG &

echo "[+] done. agent running with auto-restart."
echo "    logs: tail -f /tmp/m12-agent.log"
echo "    stop: killall m12-watchdog m12-agent"
