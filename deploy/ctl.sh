#!/usr/bin/env bash
# Manage canvas-mcp on the server Mac (run from anywhere inside the checkout, on the server itself).
#
#   deploy/ctl.sh install   npm ci + build, write the launchd agent for this machine, start it
#   deploy/ctl.sh update    git pull, npm ci + build, test, restart
#   deploy/ctl.sh restart | stop | start | status | logs
#   deploy/ctl.sh revoke    stop, revoke every OAuth grant (all clients must reconnect), start
#   deploy/ctl.sh funnel    publish the server with Tailscale Funnel and print the PUBLIC_URL to use
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

# Homebrew's tools are installed from the admin account, whose shell profile puts them on PATH.
# The service user's shell may not, so look there too.
for d in /opt/homebrew/bin /usr/local/bin; do
  [[ -d $d && ":$PATH:" != *":$d:"* ]] && PATH="$PATH:$d"
done
export PATH

die(){ echo "error: $*" >&2; exit 1; }

env_value() { # env_value NAME [default] — reads .env without sourcing it
  local v
  v="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  echo "${v:-${2:-}}"
}

node_bin() {
  local n
  n="$(command -v node)" || die "node not found on PATH. Install it with: brew install node"
  "$n" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' \
    || die "Node $("$n" -v) is too old; need 20.12+."
  echo "$n"
}

check_env() {
  [[ -f .env ]] || die "no .env here. cp .env.example .env and fill it in (see README → Deploy)."
  local missing=()
  for k in CANVAS_BASE_URL CANVAS_TOKEN PUBLIC_URL MS_CLIENT_ID MS_CLIENT_SECRET ALLOWED_EMAILS COOKIE_SECRET; do
    local v; v="$(env_value "$k")"
    if [[ -z "$v" || "$v" == *replace* || "$v" == *example.com* || "$v" == *yourschool* || "$v" == *your-tailnet* || "$v" == you@* || "$v" == 00000000-* ]]; then missing+=("$k"); fi
  done
  ((${#missing[@]} == 0)) || die ".env still has placeholders or blanks for: ${missing[*]}"
  local stale; stale="$(grep -oE '^(NTFY_URL|NTFY_TOKEN|SUBMISSIONS_DIR|APPROVAL_TTL_MINUTES)=' .env | tr -d = | tr '\n' ' ' || true)"
  [[ -z "$stale" ]] || echo "note: .env has settings that are no longer used (submissions were removed, ADR 9); you can delete: $stale" >&2
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

ts_bin() {
  command -v tailscale 2>/dev/null \
    || { [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale; } \
    || die "tailscale not found. Install it from the admin account: brew install tailscale (docs/deploy-checklist.md, step 3)."
}

funnel_url() { # https://<machine>.<tailnet>.ts.net, from this machine's Tailscale status
  "$(ts_bin)" status --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).Self?.DNSName;if(n)console.log("https://"+n.replace(/\.$/,""))})'
}

check_public_url() {
  local want got; want="$(funnel_url || true)"; got="$(env_value PUBLIC_URL)"
  [[ -z "$want" ]] && return 0
  if [[ "$got" != "$want" ]]; then
    echo "warning: PUBLIC_URL in .env is '$got' but this machine's Funnel address is '$want'." >&2
    echo "         Fix .env (and the Azure redirect URI '$want/callback'), then deploy/ctl.sh restart." >&2
  fi
}

warn_if_admin() {
  if id -Gn | tr ' ' '\n' | grep -qx admin; then
    echo "warning: $USER is an admin account. ADR 8 runs connectors as a dedicated standard user" >&2
    echo "         (docs/architecture/0008-dedicated-user-filevault-off.md). Continuing anyway." >&2
  fi
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
    warn_if_admin
    check_env
    build
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    stop
    render_plist >"$PLIST"
    plutil -lint "$PLIST" >/dev/null
    start
    health
    command -v tailscale >/dev/null 2>&1 && check_public_url
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
    if command -v tailscale >/dev/null 2>&1; then tailscale funnel status 2>/dev/null | sed 's/^/funnel: /' || true; check_public_url; fi
    ;;
  logs) tail -n 100 -f "$LOG" ;;
  funnel)
    port="$(env_value PORT 8787)"
    ts="$(ts_bin)"
    if ! "$ts" funnel --bg "$port"; then
      # The service user may not be allowed to change Funnel; it's fine if an admin already turned it on.
      "$ts" funnel status 2>/dev/null | grep -q "127.0.0.1:$port" \
        || die "Funnel failed. If it printed a link, open it to enable Funnel, then re-run. If it said 'access denied', run 'sudo tailscale funnel --bg $port' from the admin account, then re-run this."
      echo "(couldn't change Funnel as $USER, but it's already serving port $port)"
    fi
    "$ts" funnel status
    url="$(funnel_url)"
    echo
    echo "PUBLIC_URL=$url"
    echo "Azure redirect URI: $url/callback"
    echo "Connector URL:      $url/mcp"
    check_public_url
    ;;
  revoke) stop; node "$ROOT/dist/revoke-grants.js"; start; health ;;
  plist) render_plist ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
