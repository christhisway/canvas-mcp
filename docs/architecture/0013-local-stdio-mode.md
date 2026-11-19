# 13. Add a local (stdio) mode alongside the server

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

The connector runs as an HTTP server on a home-server Mac ([ADR 2](0002-node-on-home-server.md)), published with Tailscale Funnel ([ADR 7](0007-tailscale-funnel.md)) behind Microsoft sign-in ([ADR 3](0003-oauth-via-microsoft-sign-in.md)). That's what claude.ai on the web and phone needs, because it calls connectors from Anthropic's servers.

Other students want to use the same tools with their own Canvas account. For them, the server setup means an always-on machine, a tailnet, an Azure app registration and a long checklist. The options considered:

- **Each person deploys the server.** Works, but the setup is the problem.
- **One hosted, multi-user server** that stores each person's Canvas token. Canvas personal tokens can't be scoped ([ADR 6](0006-canvas-personal-access-token.md)), so the host would hold other students' full-access credentials. Not now.
- **A local stdio entry point.** Claude Desktop and Claude Code can start an MCP server as a child process on the user's own computer and talk to it over stdin/stdout.

## Decision

- **`src/stdio.ts` is a second entry point.** It builds the same server (`buildServer(createShared(...))`), so the tools are identical, and connects it to `StdioServerTransport`.
- **It needs only the Canvas settings** (`CANVAS_BASE_URL`, `CANVAS_TOKEN`, optional `TIME_ZONE`), read by `loadCanvasConfig()`. They come from the client's MCP config or from `.env` at the repo root; the client's values win.
- **No sign-in.** The process runs as the user, on their computer, started by their client, so there is nobody else to keep out.
- **Read-only is unchanged** ([ADR 9](0009-read-only-no-submissions.md)): it's the same GET-only Canvas client.
- **The HTTP server is unchanged** and stays the owner's deployment. This ADR adds to ADR 2; it doesn't supersede it.

## Consequences

- **Setup is clone, build, paste a token.** No server, tunnel or Azure app.
- **It only works in Claude Desktop and Claude Code on that computer,** not claude.ai on the web or phone. Those still need the server.
- **The Canvas token sits in plain text** in the client's config file or `.env` on the user's computer. The README says to treat it like a password and to set an expiry.
- **stdout belongs to the protocol.** Code on the tool path must never `console.log`; `stdio.ts` logs to stderr. `test/stdio.ts` checks the startup error path writes nothing to stdout.
- **`npm test` covers it:** `test/stdio.ts` starts the stdio server with only the Canvas settings against mock Canvas.
