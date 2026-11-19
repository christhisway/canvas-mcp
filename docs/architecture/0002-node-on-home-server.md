# 2. Run as a Node server on the home-server Mac, not on Cloudflare Workers

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

The original goal was for this connector to match the Microsoft To Do connector's stack and deployment, and to run on an older Mac used as a home server. Those two goals turned out to conflict: the To Do connector runs on Cloudflare Workers, and its own decisions explicitly put off any home-server move.

Moving canvas-mcp to Workers would have required:

- **R2 for file submissions,** because Workers have no filesystem. Getting files into R2 from a phone is awkward, and Workers memory (128 MB) caps realistic file sizes well under 100 MB.
- **A Durable Object for pending approvals.** KV's eventual consistency would weaken the single-use and three-attempt rules ([ADR 5](0005-out-of-band-submission-approval.md)).
- **Living with free-plan limits:** 10 ms of CPU and about 50 subrequests per request. html-to-text, file hashing and paging through Canvas across courses can exceed them.

## Decision

- **Runtime:** canvas-mcp stays a Node (Express) server.
- **Process manager:** it runs on the home-server Mac under a launchd agent (`local.canvas-mcp`), managed by `deploy/ctl.sh`.
- **Public access:** it's published over HTTPS by a tunnel ([ADR 7](0007-tailscale-funnel.md)).

Development happens on a different Mac from the one that runs it, so nothing machine-specific goes in the repo. `deploy/ctl.sh` works out paths on the server when it runs, and `.env` exists only on the server.

## Consequences

- **Kept as designed:** the approval store stays in memory in one process, `SUBMISSIONS_DIR` is a real folder (an iCloud Drive folder works), and there are no platform CPU or memory limits.
- **Uptime depends on the Mac and home internet.** The Mac must stay awake and logged in (automatic login), and the agent restarts the server if it crashes.
- **The To Do connector's OAuth library can't be reused,** because it's Workers-only. Auth is reimplemented ([ADR 3](0003-oauth-via-microsoft-sign-in.md)).
- **There are two deployment styles to maintain,** Workers for To Do and launchd for Canvas.
