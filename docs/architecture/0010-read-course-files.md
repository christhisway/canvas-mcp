# 10. Read course files: pdfjs-dist, downloads limited to Canvas, size caps

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Issue #1 asks for a `read_file` tool, so Claude can read lecture slides, handouts and other course files. That means the server downloads files and parses them, which it didn't do before:

- **Downloads leave Canvas.** A Canvas file's `url` points to the Canvas host, which redirects to file storage on another host with a signed link. The server sits on the home LAN, so the download must not be steerable to other hosts, and the Canvas token must not go anywhere but Canvas.
- **PDFs need a parser.** Most course files are PDFs. The options were:
  - `pdfjs-dist`, Mozilla's PDF.js: maintained, pure JavaScript, needs Node 22.13 or newer.
  - `unpdf`, a smaller wrapper around PDF.js: needs Node 24, and the dev machine runs 23.
  - `pdf-parse`: wraps an old PDF.js build.
  - Shelling out to `pdftotext`: needs Poppler from Homebrew, which is one more admin-account step on the server ([ADR 8](0008-dedicated-user-filevault-off.md)).
- **Files can be huge** (recordings, scanned readings), and a tool reply has to stay a size Claude can use.

## Decision

- **Parse PDFs with `pdfjs-dist`** (its legacy Node build) for text only, with no rendering. The minimum Node version goes to 22.13 in `package.json` and `deploy/ctl.sh`.
- **Only read file types that turn into text:** PDF, plain text and code, and HTML. Word, PowerPoint and images return the file's details and link. They can be added later.
- **Limit downloads** (`CanvasClient.download`):
  - The starting URL must be on the Canvas origin.
  - Redirects are followed manually, at most 5, and only to `https` (or back to the Canvas hostname).
  - The Canvas token is sent only to the Canvas origin.
  - Downloads are capped at 25 MB, checked against the file's size first and again while reading. There's a 60-second timeout.
- **Cap replies at about 40,000 characters.** PDFs stop at a page boundary and say which `from_page` to ask for next.
- **Still read-only.** Downloads are GET requests, and [ADR 9](0009-read-only-no-submissions.md) is unchanged.

## Consequences

- Claude can summarize lectures and quiz the student from course PDFs.
- **The server parses files supplied by instructors.** PDF.js is the parser Firefox uses on untrusted PDFs, and the server only extracts text. The size cap and timeout bound the work per call.
- **The server needs Node 22.13+.** Homebrew's current `node` meets that; `deploy/ctl.sh` refuses older versions.
- `npm ci` also installs PDF.js's optional native canvas package. Text extraction doesn't use it.
- **Scanned PDFs have no text layer,** so the tool can only say so. OCR would be a separate decision.
