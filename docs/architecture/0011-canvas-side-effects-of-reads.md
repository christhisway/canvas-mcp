# 11. Canvas's own bookkeeping on GET requests

- **Status:** Proposed
- **Date:** 2026-11-19

## Context

[ADR 9](0009-read-only-no-submissions.md) makes the connector read-only: `CanvasClient` sends only GET requests. Canvas sometimes records something on the server when it answers a GET, so "only GETs" isn't quite "changes nothing". GitHub #24 found one case: after a `list_modules` call, a module with no requirements showed `completed`, and its `completed_at` was the time of the call.

That fits how Canvas works: when a student's modules are listed, Canvas checks their progress and creates or updates a module progression record (the same thing happens when the student opens the Modules page). This hasn't been confirmed against Canvas's source or a real account. Other cases already known:

- **Inbox:** `GET /conversations/:id` marks the conversation read unless `auto_mark_as_read=false` is passed. `get_message` always passes it, and a smoke test checks that.
- **Discussions:** fetching a topic or its `/view` isn't expected to mark entries read (marking read is a PUT). Not yet confirmed (see "Not verified" in `CLAUDE.md`).

The options were:

- **Accept bookkeeping that matches the student's own page view**, as long as it's nothing the student would notice as a change.
- **Avoid every endpoint with any server-side effect.** That would mean dropping `list_modules`, `get_syllabus`'s module fallback and `read_file`'s module fallback. Those are the only ways to see course structure and files in a course whose Files tab is hidden.

## Decision

- **Allowed:** a GET whose only server-side effect is bookkeeping Canvas would do anyway if the student opened the same page in a browser. Module progression evaluation is an example.
- **Not allowed:** a GET that changes state the student would notice. Examples are read/unread flags, submission or attempt state, "viewed" completion requirements, and quiz attempts. Where Canvas offers a flag to turn the effect off (`auto_mark_as_read=false`), pass it and add a smoke test. Otherwise, don't call the endpoint.
- **Known side effects are listed here** when they're found, with what the connector does about each.

| Endpoint | Side effect | Handling |
|---|---|---|
| `GET /conversations/:id` | Marks the conversation read | `auto_mark_as_read=false`, smoke-tested |
| `GET /courses/:id/modules` (as a student) | May create or update module progressions, completing modules with no requirements | Allowed: Canvas does the same when the Modules page is opened |

## Consequences

- **`list_modules` stays**, along with the module fallbacks in `get_syllabus` and `read_file`.
- **A module's `completed` state may change because of a Claude call.** For a module with no requirements this has no effect on grades or access. If a module has prerequisites that depend on it, the effect is the same as the student opening the Modules page.
- **New endpoints need a check:** before adding a GET endpoint, check whether Canvas records anything when it answers, and add it to the table above if so.
- **ADR 9 is unchanged.** The connector still sends only GETs, and any write tool still needs its own ADR.
