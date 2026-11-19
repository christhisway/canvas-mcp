# canvas-mcp

A personal MCP connector for Canvas LMS. It lets Claude read your courses, what's due, assignments, grades, announcements and syllabi, and submit work — but only after you approve each submission with a one-time code sent to your phone.

## Tools

| Tool | What it does |
|---|---|
| `list_courses` | Active courses with term and current grade |
| `get_upcoming` | Your Canvas planner across all courses for a date window, with submitted/missing/graded status |
| `list_assignments` | Assignments in one course (filter by upcoming, overdue, unsubmitted, …) |
| `get_assignment` | Instructions, dates, allowed submission types/extensions, your submission and grader comments |
| `get_grades` | Overall score, assignment-group weights, graded scores |
| `list_announcements` | Recent announcements from one or all courses |
| `get_syllabus` | Syllabus page as text |
| `list_submission_files` | Files in the submissions folder |
| `prepare_submission` | Step 1: validates and stages a text, URL or file submission, sends you an approval code |
| `confirm_submission` | Step 2: submits, only with the code you type in |
| `cancel_submission` | Discards a staged submission / lists pending ones |

Courses can be referred to by code or name ("CS 240", "philosophy"), not just numeric ids.

## How submission approval works

1. You ask Claude to submit something. It calls `prepare_submission`, which checks the assignment (accepted types, file extensions, attempts left, lock state), stores the exact payload on the server, and pushes a notification to your phone via [ntfy](https://ntfy.sh) with a summary and a 6-digit code.
2. Claude shows you the preview and asks for the code. The code never appears in any tool result, so Claude can't approve on its own.
3. You type the code. `confirm_submission` submits exactly what was staged (files are hashed at staging, so they can't be swapped).

Codes expire after 15 minutes, are single-use, and three wrong guesses cancel the submission. Files can only come from `SUBMISSIONS_DIR`; nothing else on the machine is reachable.

## Setup

```bash
npm install
cp .env.example .env     # fill it in
npm run build
npm start                # or: npm run dev
```

- **Canvas token:** Canvas → Account → Settings → New Access Token.
- **Path secret:** `openssl rand -hex 24`. Your connector URL is `https://<your-host>/mcp/<secret>`, so treat the whole URL like a password.
- **ntfy:** install the ntfy app, subscribe to a long random topic, and put the same topic in `NTFY_URL`. Without `NTFY_URL`, codes print to the server log instead.

## Running on the home server

claude.ai calls connectors from the internet, so the server needs a public HTTPS address. The server binds to `127.0.0.1`; put a tunnel in front of it (Cloudflare Tunnel or Tailscale Funnel both work) and add the tunnel's hostname to `ALLOWED_HOSTS`.

To keep it running on macOS, a launchd agent (`~/Library/LaunchAgents/com.owner.canvas-mcp.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.owner.canvas-mcp</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string><string>dist/http.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/owner/development/canvas-mcp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/canvas-mcp.log</string>
  <key>StandardErrorPath</key><string>/tmp/canvas-mcp.log</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/com.owner.canvas-mcp.plist`

Then add `https://<your-host>/mcp/<secret>` as a custom connector in Claude.

## Tests

`npm test` starts a mock Canvas, runs the real server against it, and exercises every tool over MCP, including the full approval flow, the three-step file upload, and the path-secret check.

## Notes

- Pending submissions live in memory; restarting the server clears them (by design).
- The URL secret keeps strangers out, but anyone who gets the URL can read your Canvas data. If you put OAuth in front of your other connectors, use the same setup here.
