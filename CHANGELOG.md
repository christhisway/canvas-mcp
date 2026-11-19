# Changelog

Notable changes to canvas-mcp. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (before 1.0, a minor version can change tool inputs and outputs).

Issue numbers like #13 are GitHub issues. The four labelled "issue #1–#4" under 0.2.0 were the first real-Canvas fixes, made before the repo had GitHub issues. Architecture decisions are in [docs/architecture/](docs/architecture/README.md).

After deploying a version that adds or changes tools, press "Refresh tools list" in the connector's options in claude.ai. Until then, claude.ai keeps the old tool list.

## [0.4.0] - 2026-11-19

Fixes and improvements from the first live test against real Canvas. Several tools take new inputs, so refresh the tool list after deploying.

### Added

- `get_discussion`: `mine_only` returns only the student's own posts, the replies to them and the posts they replied to (#26).
- `list_events`: `include_assignments` also lists assignment and quiz due dates from the calendar, so an exam that's a quiz (such as an online "Final") is found. It's on by default when `search` is given (#23).
- `list_modules`:
  - Assignment, quiz and graded-discussion items show `submitted` / `missing` (#24).
  - `include_completed` lists the items of finished modules (#12).
- `get_syllabus`:
  - `from_char` continues a long syllabus.
  - Files the syllabus page links to are listed in `linked_files` with a `file_id` (#20).
- `get_upcoming`:
  - Quizzes and graded discussions carry `assignment_id` for `get_assignment`, `get_feedback` and `grade_whatif` (#19).
  - `marked_done` shows work the student ticked in the planner that Canvas still marks missing (#18).
- `get_grades`: each group shows `drops` and `dropped_now`; graded items can be marked `dropped` or `excluded_from_grade` (#14).
- `grade_whatif`: `projected_percent` per group when hypotheticals are given (#22).
- `list_announcements`: `limit` (default 10) (#12).
- `list_courses`: `include_past` also lists courses whose enrollment Canvas has concluded (#17).
- [ADR 11](docs/architecture/0011-canvas-side-effects-of-reads.md): reads may cause Canvas's own bookkeeping (such as module progress) when it matches the student's own page view, but nothing the student would notice as a change (#24).

### Changed

- **Smaller replies (#12):**
  - JSON replies are minified.
  - `read_file` returns up to 20,000 characters per call (was 40,000).
  - `list_announcements` gives 600-character previews across courses and full text for one course.
  - `list_modules` shortens completed modules to their name and item count.
- **Shorter tool definitions:** tool descriptions and server instructions were rewritten to be shorter. `tools/list` went from about 18,000 to 14,700 characters, and a smoke test keeps it under 15,500 (#12).
- **Past courses:** courses with a concluded enrollment resolve by course code in every tool, including the `list_messages` course filter (#17).
- **Not a student:** `get_feedback`, `get_grades`, `grade_whatif` and `recently_graded` say when the enrollment is a TA or teacher one, instead of passing on Canvas's 403 (#25).
- **`list_messages` / `get_message`:** a conversation with more than 5 other participants shows "Name + N others" or a `participant_count` instead of the whole class list (#16).
- **`get_discussion`:** in long threads, long replies are shortened first, then whole threads are left out from the end, so the replies shown have no gaps. Replies Canvas hasn't added to its cached view yet (`new_entries`) are included (#26).
- **`grade_whatif`:**
  - A letter scale set at the account level is looked up by id.
  - Says when no ungraded work is left in Canvas.
  - Says that the needed average is rounded up (#22).
- **`list_modules`:** a course with no completion requirements gets its own note instead of "Every module requirement is complete." (#24).
- **`read_file`:**
  - Says when pages are left unread after `to_page`.
  - Names unreadable types plainly ("Word documents").
  - Strips control characters.
  - Flags pages that look like maps or diagrams (#21).
- **`course_people`:** duplicate staff entries are merged, and a name that's only a login email is replaced by the person's short or sortable name (#26).
- **HTML tables** in instructions and pages come out as `a | b | c` rows (#26).
- **`get_syllabus` on a page that only links to files:** points at the syllabus file by `file_id` and also searches Files for one (#20).

### Fixed

- `get_grades` counted assignments with no score as graded zeros (#13). It ignored drop rules and `omit_from_final_grade`, so group percentages could read several points low (#14). It now uses the same calculation as `grade_whatif`, which matches Canvas.
- `list_messages` with `scope: "sent"` returned nothing on real Canvas. When that happens, it now lists conversations the student has written in (#15).
- `get_upcoming` hid missing work that had been ticked in the planner (#18).
- `get_assignment` couldn't use the quiz or discussion ids from `get_upcoming`. They now come with an `assignment_id`, and the 404 says to use it (#19).
- `get_syllabus` cut long syllabus pages off with no way to read the rest (#20).

## [0.3.0] - 2026-11-19

Eleven new read tools (GitHub #1–#9).

### Added

- `read_file`: text of course PDFs (page by page, with `from_page`), plain text, code and HTML. Downloads are limited to Canvas, and file storage never receives the token ([ADR 10](docs/architecture/0010-read-course-files.md)) (#1).
- `grade_whatif`: grade projections from group weights, drop rules and the course's letter scale. Give a target to see the average needed, or hypothetical scores to see the grade they'd give (#2).
- `get_feedback`: rubric criteria with points, ratings and comments, plus submission comments and attachments (#3).
- `course_people`: instructors and TAs, and the student's group members. It never fetches the class roster (#4).
- `recently_graded`: work graded in the last N days across courses (#5).
- `list_events`: calendar events such as exams, office hours and review sessions (#6).
- `list_discussions` / `get_discussion`: discussion prompts, threaded replies, and whether the student has posted (#7).
- `list_modules`: course structure, completion requirements and what's next (#8).
- `list_messages` / `get_message`: the Canvas inbox, never marking anything read (#9).

## [0.2.0] - 2026-11-19

The connector is read-only, and fixes from the first use against real Canvas.

### Removed

- The submission tools (`list_submission_files`, `prepare_submission`, `confirm_submission`, `cancel_submission`), the approval store and the ntfy notifier. The connector only sends GET requests to Canvas ([ADR 9](docs/architecture/0009-read-only-no-submissions.md)).

### Changed

- `list_courses` and announcements leave out courses from terms that have ended. Those courses still resolve by name or id (issue #1).
- `list_courses` and `get_grades` show the final score next to the current score, and `get_grades` lists missing work (issue #2).
- `get_syllabus` falls back to pages, files and module items named "syllabus" when the syllabus page is empty (issue #3).
- `get_upcoming` lists assignments with no due date, which the planner leaves out (issue #4).
- Personal details are kept out of committed files.

## [0.1.0] - 2026-11-19

First version.

### Added

- Read tools: `list_courses`, `get_upcoming`, `list_assignments`, `get_assignment`, `get_grades`, `list_announcements`, `get_syllabus`.
- Submission tools, each submission needing an approval code sent to a phone ([ADR 5](docs/architecture/0005-out-of-band-submission-approval.md), later superseded).
- OAuth 2.1 with Microsoft sign-in, replacing the URL secret, plus Client ID Metadata Document support for claude.ai ([ADR 3](docs/architecture/0003-oauth-via-microsoft-sign-in.md), [ADR 4](docs/architecture/0004-cimd-for-allowlisted-hosts.md)).
- Running on the home-server Mac under a dedicated user, published with Tailscale Funnel, managed by `deploy/ctl.sh`, with a deploy checklist ([ADR 2](docs/architecture/0002-node-on-home-server.md), [ADR 7](docs/architecture/0007-tailscale-funnel.md), [ADR 8](docs/architecture/0008-dedicated-user-filevault-off.md)).

[0.4.0]: https://github.com/christhisway/canvas-mcp/compare/94b09c0...main
[0.3.0]: https://github.com/christhisway/canvas-mcp/compare/a46f297...94b09c0
[0.2.0]: https://github.com/christhisway/canvas-mcp/compare/fbdf742...a46f297
[0.1.0]: https://github.com/christhisway/canvas-mcp/tree/fbdf742
