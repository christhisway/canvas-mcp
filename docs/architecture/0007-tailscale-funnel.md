# 7. Publish the server with Tailscale Funnel

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

claude.ai calls connectors from Anthropic's servers, so the home server needs a stable public HTTPS hostname. The OAuth issuer and the Azure redirect URI are tied to that hostname. The Mac sits behind a home router, and the owner has no domain. There were two candidates:

- **Tailscale Funnel**
  - Free, no domain needed.
  - HTTPS ends on the Mac, so Tailscale only relays encrypted traffic.
  - Also gives private SSH access over the tailnet.
  - The hostname is fixed (`<machine>.<tailnet>.ts.net`).
  - Nothing filters traffic before it reaches the Mac.
  - Only ports 443, 8443 and 10000 are available.
- **Cloudflare Tunnel**
  - Custom subdomains, one per connector.
  - Filtering and DDoS protection at Cloudflare's edge.
  - Needs a domain on Cloudflare (about $10 a year).
  - HTTPS ends at Cloudflare, so Cloudflare can read the traffic.
  - More setup.

## Decision

Use Tailscale Funnel. Tailscale runs as the Homebrew `tailscaled` daemon (it starts at boot). `deploy/ctl.sh funnel` runs `tailscale funnel --bg <PORT>` and prints `PUBLIC_URL`, the Azure redirect URI and the connector URL.

## Consequences

- **The Tailscale machine name becomes part of `PUBLIC_URL`.** Renaming the machine changes the URL. `deploy/ctl.sh install`, `status` and `funnel` warn when `.env` doesn't match.
- **Every request from the internet reaches the Mac.** The server's OAuth and the SDK's rate limits are the only defense. `trust proxy` is set to `loopback`, so the rate limits see real client IPs through `tailscaled`.
- **More connectors on this Mac will need extra Funnel ports** (8443, 10000) or a reverse proxy, since each OAuth server needs the root of its hostname. If that gets awkward, revisit this decision with a new ADR (most likely Cloudflare Tunnel plus a domain).
- **Switching providers later** means changing `PUBLIC_URL`, the Azure redirect URI and the connector in claude.ai.
