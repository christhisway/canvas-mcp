# 1. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Early decisions for this project lived in a handoff note and then in `CLAUDE.md`, mixed in with status and gotchas. That made them hard to find, easy to overwrite, and easy to relitigate by accident.

## Decision

Important decisions are recorded as Architecture Decision Records in `docs/architecture/`:

- **One file per decision.** Files are named `NNNN-kebab-title.md` and listed in [README.md](README.md).
- **Each ADR has the same sections:** Status (Proposed, Accepted, Deprecated, or Superseded by NNNN), Date, Context, Decision, Consequences.
- **Accepted ADRs aren't rewritten.** A change of mind gets a new ADR that supersedes the old one, and the old one's status is updated to point at it.
- **`CLAUDE.md` points here** rather than restating decisions.

## Consequences

- Before changing anything a past decision covers, search this folder first.
- New decisions need a new file, which is a little more ceremony than editing `CLAUDE.md`.
