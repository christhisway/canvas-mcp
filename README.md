# canvas-mcp

A personal MCP connector for Canvas LMS. Claude can read your courses, what's due, assignments, grades, announcements and syllabi, and it can submit work, but only after you approve each submission with a one-time code sent to your phone.

It runs as a Node server on a Mac at home, published over HTTPS with Tailscale Funnel. You connect it in claude.ai by signing in with your Microsoft account, the same way as the Microsoft To Do connector.

## Tools

| Tool | What it does |
|---|---|
| `list_courses` | Active courses with term and current grade |
| `get_upcoming` | Your Canvas planner across all courses for a date window, with submitted/missing/graded status |
| `list_assignments` | Assignments in one course (filter by upcoming, overdue, unsubmitted, …) |
| `get_assignment` | Instructions, dates, allowed submission types and extensions, your submission, grader comments |
| `get_grades` | Overall score, assignment-group weights, graded scores |
| `list_announcements` | Recent announcements from one or all courses |
| `get_syllabus` | Syllabus page as text |
| `list_submission_files` | Files in the submissions folder |
| `prepare_submission` | Step 1: validates and stages a text, URL or file submission, then sends you an approval code |
| `confirm_submission` | Step 2: submits, only with the code you type in |
| `cancel_submission` | Discards a staged submission, or lists pending ones |

Courses can be named by code or name ("CS 240", "philosophy"), not just by numeric id.

## How it works

```
Claude ──▶ https://<machine>.<tailnet>.ts.net/mcp (Bearer token, via Tailscale Funnel) ──▶ Canvas REST API (your personal access token)
   │
   └─ connect: /authorize (consent page) ──▶ Microsoft sign-in ──▶ /callback ──▶ /token ──▶ token back to Claude
```

- **Access.** The server is its own OAuth 2.1 authorization server, built on the MCP SDK's auth router. To connect, you approve a consent page and sign in with Microsoft. Only accounts in `ALLOWED_EMAILS` get through, and if the list is empty nobody does. Microsoft is used only to check who you are; no Microsoft token is kept. Canvas is reached with your Canvas token, which never leaves the server.
- **Clients.** claude.ai identifies itself with a Client ID Metadata Document, which the server accepts only from hosts in `CIMD_ALLOWED_HOSTS` (default `claude.ai`). Other clients, such as the MCP Inspector, use dynamic client registration.
- **Tokens.** Access tokens last 1 hour. Refresh tokens last 30 days, rotate on every use, and are extended each time they're used. Only SHA-256 hashes are stored, in `DATA_DIR/oauth.json` (mode 0600). `deploy/ctl.sh revoke` signs everything out.

Why it's built this way (Node on a home server, Microsoft sign-in, Funnel, approval codes) is recorded in [docs/architecture/](docs/architecture/README.md).

### Submission approval

1. You ask Claude to submit something. It calls `prepare_submission`, which checks the assignment: accepted types, file extensions, attempts left, and lock state. The tool then stores the exact payload on the server and pushes a notification to your phone via [ntfy](https://ntfy.sh) with a summary and a 6-digit code.
2. Claude shows you the preview and asks for the code. The code never appears in any tool result, so Claude can't approve on its own.
3. You type the code. `confirm_submission` submits exactly what was staged. Files are hashed when they're staged, so they can't be swapped afterwards.

Codes expire after 15 minutes and are single-use, and three wrong guesses cancel the submission. Files can only come from `SUBMISSIONS_DIR`; nothing else on the machine can be read. Pending submissions live in memory, so a restart clears them. That's intentional.

## Deploy (on the server Mac)

**Follow [docs/deploy-checklist.md](docs/deploy-checklist.md).** It's the step-by-step list, from preparing the Mac to the first real submission. In outline:

1. **Keep the Mac awake and logged in.** Set `pmset`, turn on automatic login (launchd agents only run while you're logged in), and turn on Remote Login for SSH.
2. **Install tools:** `brew install node git gh tailscale`, then sign in to GitHub.
3. **Tailscale.** Run `sudo brew services start tailscale` and `sudo tailscale up`. In the admin console, give the machine a permanent name and **disable key expiry**.
4. **Clone the repo, then run `deploy/ctl.sh funnel`.** It turns on Funnel and prints `PUBLIC_URL`, the Azure redirect URI and the connector URL. claude.ai calls the connector from Anthropic's servers, so it needs this public HTTPS address. HTTPS ends on the Mac; Tailscale only relays the traffic.
5. **Gather the secrets.**
   - Azure: add `<PUBLIC_URL>/callback` to the To Do app registration and create a separate client secret.
   - Canvas: create a personal access token.
   - ntfy: subscribe your phone to a long random topic.
6. **Fill in `.env`,** then run `deploy/ctl.sh install`. It builds the server, writes a launchd agent with this Mac's paths, and starts it.
7. **Add `<PUBLIC_URL>/mcp`** as a custom connector in claude.ai and sign in with Microsoft.

Day-to-day:

```
deploy/ctl.sh update      git pull, npm ci, build, test, restart
deploy/ctl.sh status      launchd state, health check, Funnel status
deploy/ctl.sh logs        follow the log (~/Library/Logs/canvas-mcp.log)
deploy/ctl.sh restart | stop | start
deploy/ctl.sh revoke      sign out every connected client
deploy/ctl.sh funnel      (re)enable Funnel and print the URLs
```

## Develop

```bash
npm install
npm test          # mock Canvas + mock Microsoft, end to end over real HTTP
npm run dev       # tsx watch; needs a .env with PUBLIC_URL=http://localhost:8787
npm run build && npm start
```

`http://localhost:8787/callback` is already a redirect URI on the To Do Azure app, so local sign-in works with the same client id.

## Troubleshooting

- **"This Microsoft account is not allowed".** The account's email doesn't match `ALLOWED_EMAILS`. The log line `Rejected sign-in from …` shows the address it saw.
- **AADSTS50011 (redirect URI mismatch).** `<PUBLIC_URL>/callback` is missing from the Azure app, or `PUBLIC_URL` doesn't match the tunnel address.
- **claude.ai says the connection failed before the consent page appears.** The server couldn't fetch claude.ai's client metadata; check the log for `CIMD fetch failed`. Setting `CIMD_ALLOWED_HOSTS=none` makes claude.ai register instead.
- **403 "Invalid Host header".** The request's hostname isn't `PUBLIC_URL`'s; usually the machine was renamed in Tailscale. `deploy/ctl.sh status` warns about a mismatch.
- **Public URL doesn't load.** Check `tailscale funnel status`. A brand-new hostname can take a few minutes to resolve.
