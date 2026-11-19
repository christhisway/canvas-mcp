# Handoff: canvas-mcp

Context for Claude Code picking this up from a claude.ai session (2026-11-19).

## Goal
A personal Canvas LMS MCP connector for the owner, run remotely on a home-server Mac so it works in claude.ai and on a phone. It should live next to the owner's Microsoft To Do connector and follow the same stack and deployment.

## Decisions already made
- **Structure:** standalone repo (`~/development/canvas-mcp`), using the **same stack and deployment as the To Do connector**.
- **Scope:** read access + submissions. **Every submission needs the owner's explicit approval.**
- **Hosting:** remote, on the home server, reachable over public HTTPS.
- **Canvas auth:** personal access token (Canvas → Account → Settings → New Access Token). Developer-key OAuth needs institution admin approval, so it's out of scope.

## Current state
Working and tested against a mock Canvas; **never run against real Canvas yet.**

- TypeScript, `@modelcontextprotocol/sdk` 1.32.x, Express, zod 4, stateless Streamable HTTP.
- Endpoint: `POST /mcp/<MCP_PATH_SECRET>` (wrong secret → 404). `GET /healthz` for liveness.
- `npm test` spawns the real server against `test/mock-canvas.ts` and runs 16 checks over MCP. All pass.
- `npx tsc --noEmit` is clean.

### Layout
```
src/
  http.ts          Express entry, path-secret check, per-request server + transport
  server.ts        buildServer(), shared long-lived state (Canvas client, course cache, approvals)
  config.ts        env loading (see .env.example)
  canvas.ts        Canvas REST client: Link-header pagination, rate-limit retry, 3-step file upload
  courses.ts       active-course cache + resolve("CS 240" | "philosophy" | id)
  approvals.ts     pending-submission store, one-time codes, ntfy/console notifiers
  format.ts        html→text, time-zone date formatting, compact()
  types.ts         Canvas object subsets
  tools/read.ts    list_courses, get_upcoming, list_assignments, get_assignment,
                   get_grades, list_announcements, get_syllabus
  tools/submit.ts  list_submission_files, prepare_submission, confirm_submission, cancel_submission
test/
  mock-canvas.ts   fake Canvas + fake ntfy endpoint
  smoke.ts         end-to-end checks
```

### Submission approval design (keep this intact)
1. `prepare_submission` validates the assignment (accepted types, allowed extensions, attempts left, lock state; warns on late/resubmission), stores the **exact payload server-side** (files are read and sha256-hashed at this point), and sends a 6-digit code to the owner's phone via ntfy.
2. The code **never appears in any tool result**. The model has to ask the owner to type it.
3. `confirm_submission(pending_id, code)` submits only what was staged. Codes are single-use, expire after 15 min, and 3 wrong codes cancel the submission. At most 5 pending at once.
4. Files can only come from `SUBMISSIONS_DIR` (realpath-checked, no path separators, ≤100 MB).

Pending submissions are in memory, so a restart clears them. That's intentional.

## Next steps (in order)
1. **Read the To Do connector's repo** and align canvas-mcp with it: language/runtime, MCP SDK usage, project layout, env handling, auth, and how it's deployed and exposed on the home server (tunnel, process manager). Where they differ, follow the To Do connector unless doing so would weaken the approval design above.
2. **Replace or back up the URL-secret auth.** Right now anyone with the URL can read Canvas data, though they can't submit without the phone code. If the To Do connector uses OAuth or another scheme, reuse it.
3. **First run against real Canvas.** Get a token, set `CANVAS_BASE_URL` to the school's Canvas address, and call each read tool. Likely rough edges: `get_upcoming` planner shapes for quizzes and discussions, assignment-group edge cases, course entries with null names.
4. **Try a real submission end to end** on a low-stakes assignment, ideally a practice or sandbox course. In particular, verify the storage-upload step in `canvas.uploadSubmissionFile`: the school's storage backend may answer with a 201 JSON body or a 3xx redirect, and both paths are handled but only the redirect path is tested.
5. **Set up ntfy** (app on phone, long random topic in `NTFY_URL`) and deploy behind the same tunnel and process manager as the To Do connector. The README has a launchd example if there's nothing to copy.
6. Add as a custom connector in claude.ai. Optionally set `confirm_submission` to ask before running in the connector's tool permissions, as a second gate.

## Possible later additions
Modules, files, quiz details, discussions, inbox, planner notes. All read-only, unless the owner asks for more writes; any new write should go through the same approval flow.

## Commands
```bash
npm install
cp .env.example .env   # fill in
npm test               # mock Canvas, end to end
npm run dev            # tsx watch
npm run build && npm start
```
