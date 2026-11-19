#!/usr/bin/env bash
# Manage canvas-mcp on the server Mac (run from anywhere inside the checkout, on the server itself).
#
#   deploy/ctl.sh install   npm ci + build, write the launchd agent for this machine, start it
#   deploy/ctl.sh update    git pull, npm ci + build, test, restart
#   deploy/ctl.sh restart | stop | start | status | logs
#   deploy/ctl.sh revoke    stop, revoke every OAuth grant (all clients must reconnect), start
#   deploy/ctl.sh plist     print the launchd plist this machine would get (changes nothing)
#
# Nothing here is machine-specific until it runs: paths come from where the checkout lives and
# which `node` is on PATH on the server.
set -euo pipefail

LABEL="local.canvas-mcp"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/canvas-mcp.log"
DOMAIN="gui/$(id -u)"

cd "$ROOT"

die() { echo "error: $*" >&2; exit 1; }

env_value() { # env_value NAME [default] — reads .env without sourcing it
  local v
  v="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  echo "${v:-${2:-}}"
}

node_bin() {
  local n
  n="$(command -v node)" || die "node not found on PATH. Install Node 22 (e.g. brew install node@22)."
  "$n" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' \
    || die "Node $("$n" -v) is too old; need 20.12+."
  echo "$n"
}

check_env() {
  [[ -f .env ]] || die "no .env here. cp .env.example .env and fill it in (see README → Deploy)."
  local missing=()
  for k in CANVAS_BASE_URL CANVAS_TOKEN PUBLIC_URL MS_CLIENT_ID MS_CLIENT_SECRET ALLOWED_EMAILS COOKIE_SECRET; do
    local v; v="$(env_value "$k")"
    if [[ -z "$v" || "$v" == *replace* || "$v" == *example.com* || "$v" == *yourschool* || "$v" == you@* || "$v" == 00000000-* ]]; then missing+=("$k"); fi
  done
  ((${#missing[@]} == 0)) || die ".env still has placeholders or blanks for: ${missing[*]}"
  [[ "$(stat -f %Lp .env)" == "600" ]] || { chmod 600 .env; echo "set .env to mode 600"; }
}

render_plist() {
  local node; node="$(node_bin)"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$ROOT/dist/http.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$node"):/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
}

build() {
  npm ci --no-audit --no-fund
  npm run build
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

start() {
  [[ -f "$PLIST" ]] || die "not installed yet; run deploy/ctl.sh install"
  loaded || launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
}

stop() { if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi; }

health() {
  local port; port="$(env_value PORT 8787)"
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      echo "healthy on 127.0.0.1:$port (public: $(env_value PUBLIC_URL)/mcp)"
      return 0
    fi
    sleep 0.5
  done
  echo "not answering on 127.0.0.1:$port. Last log lines:" >&2
  tail -n 20 "$LOG" >&2 || true
  return 1
}

case "${1:-}" in
  install)
    check_env
    build
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    stop
    render_plist >"$PLIST"
    plutil -lint "$PLIST" >/dev/null
    start
    health
    case "$(node_bin)" in
      *"/.nvm/"*|*"/.fnm/"*|*"/.volta/"*) echo "note: node comes from a version manager; re-run install after switching Node versions." ;;
    esac
    ;;
  update)
    git pull --ff-only
    build
    npm test
    launchctl kickstart -k "$DOMAIN/$LABEL"
    health
    ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL"; health ;;
  stop) stop; echo "stopped" ;;
  start) start; health ;;
  status)
    if loaded; then launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|last exit code) =" || true; else echo "not loaded"; fi
    health || true
    ;;
  logs) tail -n 100 -f "$LOG" ;;
  revoke) stop; node "$ROOT/dist/revoke-grants.js"; start; health ;;
  plist) render_plist ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
