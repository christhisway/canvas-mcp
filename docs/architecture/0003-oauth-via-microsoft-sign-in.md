# 3. OAuth 2.1 with Microsoft sign-in, replacing the URL secret

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

The first version authenticated with a secret in the URL path (`/mcp/<secret>`), so anyone holding the URL could read Canvas data. Submitting still needed the phone code.

The To Do connector already solves this: it acts as an OAuth 2.1 authorization server toward Claude, shows a consent page, signs the user in with Microsoft (Entra ID), and admits only allowlisted emails. Its library, `@cloudflare/workers-oauth-provider`, only runs on Workers ([ADR 2](0002-node-on-home-server.md)).

## Decision

Reimplement the To Do connector's flow in Node on the MCP SDK's `mcpAuthRouter`, with a custom `OAuthServerProvider` (`src/auth/provider.ts`):

- **The flow:** `/authorize` shows a consent page. Approving POSTs to `/consent`, which sends the user to Microsoft sign-in with PKCE. Microsoft returns to `/callback`, which issues this server's own authorization code, and `/token` exchanges it for tokens.
- **Microsoft is identity only.**
  - Scope is `User.Read`, and no Microsoft token is stored. Canvas is reached with the server's own Canvas token ([ADR 6](0006-canvas-personal-access-token.md)).
  - It uses the same Azure app registration as To Do, with its own redirect URI (`<PUBLIC_URL>/callback`) and its own client secret, so each connector's secret can be rotated alone.
- **`ALLOWED_EMAILS` fails closed.** It's checked at sign-in and again on every token check and refresh.
- **Consent is remembered for 30 days** per client and redirect URI, in an HMAC-signed cookie.
- **Tokens are opaque.**
  - Access tokens last 1 hour.
  - Refresh tokens last 30 days, are extended each time they're used, and rotate. The previous refresh token stays valid until the new one is used, matching workers-oauth-provider.
  - Reusing an authorization code revokes the grant it produced.
  - Only SHA-256 hashes are stored, in `DATA_DIR/oauth.json` (mode 0600).
- **Every token is issued for exactly one resource,** `<PUBLIC_URL>/mcp`. Requests naming another resource get `invalid_target`.

## Consequences

- The connector URL is simply `<PUBLIC_URL>/mcp`, and connecting needs an interactive Microsoft sign-in.
- This server now owns security-sensitive code (flows, cookies, token storage) that the To Do connector gets from a library. The smoke test covers it: forged consent, replayed callbacks, PKCE, code reuse, refresh rotation, revocation and the allowlist.
- A running server holds the grants in memory, so revoking means stop → revoke → start (`deploy/ctl.sh revoke`).
