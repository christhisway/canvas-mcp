# 6. Reach Canvas with a personal access token

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Canvas supports OAuth through developer keys, but at the school an institution admin has to issue and approve them. This is a single-user, personal connector.

## Decision

The server calls the Canvas REST API with the student's personal access token (Canvas → Account → Settings → New Access Token), set as `CANVAS_TOKEN` in the server's `.env`.

## Consequences

- **No admin involvement,** and the setup is simple.
- **The token has the full power of the student's account and never leaves the server.** It's never sent to the file-storage host during uploads; a test checks this.
- **It's strictly single-user.** Who may *use* the server is controlled separately ([ADR 3](0003-oauth-via-microsoft-sign-in.md)).
- **Rotation is manual:** create a new token in Canvas, update `.env`, and restart.
