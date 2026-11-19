# CLAUDE.md: canvas-mcp

A personal Canvas LMS MCP connector for the owner, a student who is comfortable with TypeScript. README.md has the user-facing setup and tool list. This file covers current state and gotchas.

Repo: `christhisway/canvas-mcp` on GitHub. Its sibling is the owner's Microsoft To Do connector.

## The dev machine is not the server

Code is written on one Mac and runs on another: an older Mac, used as a home server.

- Never bake dev-machine paths, users or secrets into the repo.
- `deploy/ctl.sh` works out every path on the server when it runs.
- `.env` exists only on the server and is never committed.
- Steps that need the server, a browser, the Azure portal or a phone are the owner's to do. Tell them exactly what to run or click.

## Decisions: see `docs/architecture/`

Important decisions are recorded as ADRs in [docs/architecture/](docs/architecture/README.md). Read that index first.

- **Search the folder** (for example `grep -ril <topic> docs/architecture`) before changing anything that touches hosting, auth, the tunnel, Canvas access, or the submission approval flow.
- **Don't relitigate an accepted ADR** unless the owner raises it.
- **Record a new decision as a new ADR** using the format in ADR 1, add it to the index, and supersede rather than rewrite old ones.
- **Don't restate decisions in this file.**

## Layout

```
src/
  http.ts            Express entry: AS metadata (+CIMD flag), mcpAuthRouter, consent/callback routes, Bearer-guarded /mcp
  config.ts          env loading (see .env.example)
  auth/provider.ts   OAuthServerProvider: consent flow, Microsoft hop, auth codes, token issue/refresh/verify/revoke
  auth/store.ts      oauth.json persistence (clients, grants; token hashes only), DCR client cap
  auth/microsoft.ts  Microsoft authorize URL, code exchange + /me, allowlist, PKCE
  auth/cimd.ts       Client ID Metadata Document fetch, allowlisted hosts only
  auth/pages.ts      consent/error HTML
  server.ts          buildServer(), shared long-lived state (Canvas client, course cache, approvals)
  canvas.ts          Canvas REST client: Link-header pagination, rate-limit retry, 3-step file upload
  courses.ts         active-course cache + resolve("CS 240" | "philosophy" | id)
  approvals.ts       pending-submission store, one-time codes, ntfy/console notifiers
  format.ts          html→text, time-zone dates, compact()
  tools/read.ts      list_courses, get_upcoming, list_assignments, get_assignment, get_grades, list_announcements, get_syllabus
  tools/submit.ts    list_submission_files, prepare_submission, confirm_submission, cancel_submission
  revoke-grants.ts   wipes all grants (used by deploy/ctl.sh revoke)
deploy/ctl.sh        install/update/restart/status/logs/revoke/funnel on the server (launchd agent local.canvas-mcp)
test/smoke.ts        spawns the real server against test/mock-canvas.ts (Canvas + Microsoft + ntfy + CIMD doc); 27 checks
test/oauth-client.ts plays Claude + the browser through the OAuth flow
docs/architecture/   ADRs (decisions); index in README.md
```

## Submission approval design

Keep it intact: see [ADR 5](docs/architecture/0005-out-of-band-submission-approval.md). Any new write tool goes through the same flow.

## Auth gotchas

- **claude.ai uses CIMD.** The To Do connector saw `client_id` as a `https://claude.ai/...` URL, and `/register` was never called.
  - The SDK has no CIMD support. `auth/cimd.ts` adds it, limited to `CIMD_ALLOWED_HOSTS` (default `claude.ai`) so the server can't be used to fetch arbitrary URLs from inside the home LAN.
  - `http.ts` serves its own `/.well-known/oauth-authorization-server`, registered before the SDK router, to add `client_id_metadata_document_supported`.
  - `CIMD_ALLOWED_HOSTS=none` removes the flag, so clients fall back to DCR.
- **DCR is unauthenticated.**
  - `store.ts` caps it at 50 clients and evicts the oldest ones that have no grant.
  - `clientSecretExpirySeconds: 0`, because the SDK's default 30-day secret expiry would break refresh for confidential clients.
- **Tokens.**
  - Access tokens are opaque `cmcp_at_…` strings that last 1 hour. Refresh tokens are `cmcp_rt_…`, last 30 days, are extended on each use, and rotate.
  - The previous refresh token stays valid until the new one is used, which is the same rule as workers-oauth-provider.
  - Reusing an auth code revokes the grant it created.
  - `ALLOWED_EMAILS` is re-checked on every token verify and refresh, so removing an email locks that account out immediately.
- **Every token's resource is `<PUBLIC_URL>/mcp`.** Authorize or token requests naming another resource get `invalid_target`, and `requireBearerAuth` checks `expectedResource`.
- **Flow state.** The consent POST and the Microsoft callback must carry the `__Host-canvas-auth` cookie set at `/authorize`; on plain-http localhost the cookie is just `canvas-auth`. The callback is one-shot.
- **A running server holds the grants in memory** and rewrites `oauth.json` on every change. Stop it before editing or revoking (`deploy/ctl.sh revoke` does that).
- **Behind Funnel,** `tailscaled` proxies from loopback. `trust proxy` is set to `loopback` so the SDK's rate limits see real client IPs. The Host-header check allows `PUBLIC_URL`'s hostname plus loopback.
- **The Funnel hostname comes from the Tailscale machine name.** Renaming the machine changes the URL. `deploy/ctl.sh funnel`, `install` and `status` compare `PUBLIC_URL` against `tailscale status --json` and warn on a mismatch.

## Verified vs. not

Verified (2026-11-19, mocks only; `npm test`, 27/27 passing; `tsc` clean for `src` and `test`):
- Metadata and the 401 challenge.
- DCR and CIMD sign-in through the consent page → Microsoft → callback → token.
- Wrong PKCE verifier, missing client secret, and code reuse (which revokes the grant).
- Refresh rotation with the one-retry rule, and refresh attempted by a different client.
- An account not on the allowlist is turned away.
- A forged consent POST and a replayed callback are rejected. Cancel works, and consent is remembered.
- Foreign resource, revocation, and the 0600 store holding only hashes.
- All 11 tools, including the full approval flow against mock Canvas.

Not verified (needs the server and real accounts):
- Real Microsoft sign-in with the shared Azure app, and that the owner's `/me` email matches `ALLOWED_EMAILS`.
- claude.ai's real CIMD document parsing (`OAuthClientMetadataSchema`, `token_endpoint_auth_method: none`), and whether the fetch works from a home IP.
- The refresh path from claude.ai after more than an hour.
- Real Canvas. Likely rough edges:
  - `get_upcoming` planner shapes for quizzes and discussions
  - assignment-group edge cases
  - course entries with null names
- `canvas.uploadSubmissionFile` against the school's storage. It might answer 201 JSON or a 3xx; only the 3xx path is tested.
- Tailscale Funnel on the server, launchd, and iCloud Drive access from a LaunchAgent (it may need Full Disk Access for `node`).
  - `deploy/ctl.sh funnel` was only run here against a stand-in `tailscale` script; real Funnel output formats weren't checked.
  - Does Funnel forward the original Host header? Either way works, because loopback is allowed.
- `deploy/ctl.sh install/update` on the server. On the dev machine only `plist` was run, plus the `.env` placeholder check.

## Next steps (in order)

1. **On the server**, follow README "Deploy" in order:
   - prepare the Mac and clone
   - install Tailscale, name the machine, run `deploy/ctl.sh funnel` (this sets `PUBLIC_URL`)
   - write `.env`, add the Azure redirect URI and a new secret, set up ntfy
   - run `deploy/ctl.sh install`
2. **Check** that `<PUBLIC_URL>/healthz` loads from outside the home network.
3. **Connect in claude.ai**. Watch `deploy/ctl.sh logs` during the OAuth flow, then call each read tool.
4. **Do a real submission** on a low-stakes or sandbox assignment, and confirm the upload path.
5. **Confirm refresh works** more than an hour after connecting (look for `POST /token` in the log with no reconnect prompt).

## Possible later additions

Modules, files, quiz details, discussions, inbox and planner notes. All read-only unless the owner asks for more writes.

## Commands

```bash
npm test                 # mock Canvas + Microsoft, end to end
npm run typecheck
npm run dev              # needs .env with PUBLIC_URL=http://localhost:8787
deploy/ctl.sh <cmd>      # on the server only
```
