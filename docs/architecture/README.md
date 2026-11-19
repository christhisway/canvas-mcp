# Architecture decisions

Important decisions for canvas-mcp, one record per file. Read the relevant ADR before changing anything it covers. A change of mind gets a new ADR that supersedes the old one; accepted ADRs aren't rewritten. See [ADR 1](0001-record-architecture-decisions.md) for the format.

| # | Decision | Status |
|---|---|---|
| [1](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [2](0002-node-on-home-server.md) | Run as a Node server on the home-server Mac, not on Cloudflare Workers | Accepted |
| [3](0003-oauth-via-microsoft-sign-in.md) | OAuth 2.1 with Microsoft sign-in, replacing the URL secret | Accepted |
| [4](0004-cimd-for-allowlisted-hosts.md) | Accept Client ID Metadata Documents from allowlisted hosts, alongside DCR | Accepted |
| [5](0005-out-of-band-submission-approval.md) | Every submission needs an out-of-band approval code | Superseded by [9](0009-read-only-no-submissions.md) |
| [6](0006-canvas-personal-access-token.md) | Reach Canvas with a personal access token | Accepted |
| [7](0007-tailscale-funnel.md) | Publish the server with Tailscale Funnel | Accepted |
| [8](0008-dedicated-user-filevault-off.md) | Run connectors as a dedicated standard user, with FileVault off and automatic login | Superseded by [12](0012-filevault-on-owner-apple-id.md) |
| [9](0009-read-only-no-submissions.md) | Read-only: remove the submission feature | Accepted |
| [10](0010-read-course-files.md) | Read course files: pdfjs-dist, downloads limited to Canvas, size caps | Accepted |
| [11](0011-canvas-side-effects-of-reads.md) | Canvas's own bookkeeping on GET requests | Accepted |
| [12](0012-filevault-on-owner-apple-id.md) | FileVault on, no automatic login; `devserver` signs in to the owner's Apple ID | Accepted |
