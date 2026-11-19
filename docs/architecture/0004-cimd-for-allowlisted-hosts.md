# 4. Accept Client ID Metadata Documents from allowlisted hosts, alongside DCR

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

When claude.ai connected to the To Do connector, it identified itself with a Client ID Metadata Document (CIMD): its `client_id` was a `https://claude.ai/...` URL, and it never called `/register`. The MCP SDK (1.32) has no CIMD support and doesn't advertise it. Without CIMD, claude.ai should fall back to dynamic client registration (DCR), but that path was never verified.

Supporting CIMD means fetching a URL the client supplies. On a home server, an open fetcher like that could reach other machines on the LAN.

## Decision

- **Accept CIMD client ids only from hosts in `CIMD_ALLOWED_HOSTS`** (default `claude.ai`; see `src/auth/cimd.ts`).
  - https only, no redirects, a 5 s timeout, and a 16 KB cap.
  - The document's `client_id` must equal its URL, and only public clients are allowed (`token_endpoint_auth_method: none`).
  - Documents are cached for 1 hour.
- **Advertise CIMD** by serving the authorization-server metadata from `http.ts`, registered before the SDK router, with `client_id_metadata_document_supported: true`.
- **Keep DCR** for other clients, such as the MCP Inspector.
  - The SDK's 30-day client-secret expiry is turned off.
  - Registered clients are capped at 50; the oldest ones without a grant are evicted first.
- **`CIMD_ALLOWED_HOSTS=none` turns CIMD off and removes the flag,** so clients fall back to DCR.

## Consequences

- claude.ai should connect the same way it does with the To Do connector. Whether its real document parses, and whether the fetch works from a home IP, is still unverified.
- Exposure to server-side request forgery (SSRF) is limited to the hosts on the allowlist.
