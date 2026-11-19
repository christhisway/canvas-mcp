# 5. Every submission needs an out-of-band approval code

- **Status:** Accepted
- **Date:** 2026-11-19 (designed in the claude.ai session that produced the first version)

## Context

Submitting to Canvas can't be undone and can hurt the owner's grades. A model should never be able to submit on its own, even when asked by text injected into a page or file. A tool-permission prompt in Claude depends on client settings and is easy to approve without reading.

## Decision

Submission is two steps, and the second needs a code that only reaches the owner's phone:

1. **`prepare_submission` validates and stages.**
   - It checks the assignment: accepted types, allowed extensions, attempts left, and lock state. It warns on late submissions and resubmissions.
   - It stores the **exact payload server-side**. Files are read and sha256-hashed at this point.
   - It sends a 6-digit code to the owner's phone via ntfy.
2. **The code never appears in any tool result.** The model must ask the owner to type it.
3. **`confirm_submission(pending_id, code)` submits only what was staged.**
   - Codes are single-use and expire after 15 minutes.
   - Three wrong codes cancel the submission.
   - At most 5 submissions can be pending at once.
4. **Files can only come from `SUBMISSIONS_DIR`.** The path is realpath-checked and can't contain path separators, and files must be 100 MB or less.

Pending submissions live in memory, so a restart clears them. That's intentional.

## Consequences

- Any future write tool must go through the same flow.
- The design needs a single long-lived process, which is one reason for [ADR 2](0002-node-on-home-server.md).
- It depends on ntfy delivery. If ntfy fails, nothing is staged. If `NTFY_URL` isn't set, codes print to the server log, which is meant only for local development.
- Anyone subscribed to the ntfy topic sees the codes, so the topic must be long and random.
