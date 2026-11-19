# 9. Read-only: remove the submission feature

- **Status:** Accepted
- **Date:** 2026-11-19
- **Supersedes:** [ADR 5](0005-out-of-band-submission-approval.md)

## Context

The connector could submit assignments through four tools (`list_submission_files`, `prepare_submission`, `confirm_submission`, `cancel_submission`), gated by a phone code ([ADR 5](0005-out-of-band-submission-approval.md)). Before it was ever deployed, the owner weighed it against submitting by hand:

- **Files are slow.** An MCP tool only receives arguments the model types. A file attached in claude.ai can't be passed through as its original bytes, so a file had to be copied into `SUBMISSIONS_DIR` on the server first (over SSH, or through a shared iCloud folder). Copying the file, going back to Claude and typing the code takes longer than dragging the file into Canvas.
- **Text and URL submissions were the only quick case,** and pasting those into Canvas takes seconds too.
- **It cost setup and risk:**
  - ntfy, the submissions folder, optional iCloud access from a LaunchAgent, and a real-submission test on the deploy checklist
  - an upload path never tested against the school's Canvas storage
  - a write path on grades that a prompt-injected model could aim at, even if the code stopped it

## Decision

- **The connector is read-only.**
  - The submission tools, the approval store and ntfy notifier, `SUBMISSIONS_DIR`, and `NTFY_*`/`APPROVAL_TTL_MINUTES` are removed.
  - `CanvasClient` sends only GET requests; it has no POST, upload or form methods.
  - The smoke test checks that every request to Canvas was a GET and that every tool is annotated read-only.
- **Any future write tool needs a new ADR first.** ADR 5's flow (stage the exact payload server-side, a code sent only to the phone, single use, short expiry) is the starting point if writes ever come back. The removed code is in git history before this ADR's commit.

## Consequences

- **Claude can't hand anything in.** It reads assignments and gives the student the assignment's link to submit themselves.
- **Deployment is shorter.** No ntfy topic, no submissions folder, and no iCloud Apple ID on the server user.
- **The Canvas token still has full access.** Canvas personal tokens can't be scoped, so read-only is a property of the server's code, not the token. Someone with the disk still has a full token ([ADR 8](0008-dedicated-user-filevault-off.md)), and the token's semester expiry is still the main limit on that ([ADR 6](0006-canvas-personal-access-token.md)).
- **Parts of earlier ADRs no longer apply, but their decisions stand:**
  - [ADR 2](0002-node-on-home-server.md) gave the in-memory approval store and a real `SUBMISSIONS_DIR` folder as reasons to run Node on the Mac. Its other reasons, such as no CPU limits and a single long-lived process for the course cache, still hold.
  - [ADR 8](0008-dedicated-user-filevault-off.md)'s notes on submission files and the throwaway Apple ID are moot. Its dedicated user and FileVault decisions are unchanged.
