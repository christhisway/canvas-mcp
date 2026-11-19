# canvas-mcp

A personal, read-only MCP connector for Canvas LMS. Claude can read your courses, what's due, assignments, grades, announcements and syllabi. It can't submit or change anything; you hand work in yourself ([ADR 9](docs/architecture/0009-read-only-no-submissions.md)).

It runs as a Node server on a Mac at home, published over HTTPS with Tailscale Funnel. You connect it in claude.ai by signing in with your Microsoft account, the same way as the Microsoft To Do connector.

## Tools

| Tool | What it does |
|---|---|
| `list_courses` | Current courses with term, current and final grade (past-term courses on request) |
| `get_upcoming` | Your Canvas planner across all courses for a date window, with submitted/missing/graded status, plus assignments with no due date |
| `list_assignments` | Assignments in one course (filter by upcoming, overdue, unsubmitted, …) |
| `get_assignment` | Instructions, dates, allowed submission types and extensions, your submission, grader comments |
| `get_grades` | Current and final score, assignment-group weights, graded scores, missing work |
| `list_announcements` | Recent announcements from one or all courses |
| `get_syllabus` | Syllabus page as text; if it's empty, a page, file or module item named "syllabus" |

Courses can be named by code or name ("CS 240", "philosophy"), not just by numeric id. A course from a past term is found by name only when no current course matches.

## How it works

```
Claude ──▶ https://<machine>.<tailnet>.ts.net/mcp (Bearer token, via Tailscale Funnel) ──▶ Canvas REST API (your personal access token)
   │
   └─ connect: /authorize (consent page) ──▶ Microsoft sign-in ──▶ /callback ──▶ /token ──▶ token back to Claude
```

- **Access.** The server is its own OAuth 2.1 authorization server, built on the MCP SDK's auth router. To connect, you approve a consent page and sign in with Microsoft. Only accounts in `ALLOWED_EMAILS` get through, and if the list is empty nobody does. Microsoft is used only to check who you are; no Microsoft token is kept. Canvas is reached with your Canvas token, which never leaves the server, and only with GET requests.
- **Clients.** claude.ai identifies itself with a Client ID Metadata Document, which the server accepts only from hosts in `CIMD_ALLOWED_HOSTS` (default `claude.ai`). Other clients, such as the MCP Inspector, use dynamic client registration.
- **Tokens.** Access tokens last 1 hour. Refresh tokens last 30 days, rotate on every use, and are extended each time they're used. Only SHA-256 hashes are stored, in `DATA_DIR/oauth.json` (mode 0600). `deploy/ctl.sh revoke` signs everything out.

Why it's built this way (Node on a home server, Microsoft sign-in, Funnel, read-only) is recorded in [docs/architecture/](docs/architecture/README.md).

## Deploy (on the server Mac)

**Follow [docs/deploy-checklist.md](docs/deploy-checklist.md).** It's the step-by-step list, from preparing the Mac to the first real use in claude.ai.

The server runs as a dedicated **standard** macOS user (`devserver`) that logs in automatically. Your admin account does the system setup. FileVault is off so automatic login works, which is why the disk holds only secrets you can revoke ([ADR 8](docs/architecture/0008-dedicated-user-filevault-off.md)). In outline:

1. **Admin account:**
   - run `pmset` so the Mac stays awake
   - create the `devserver` user and set it to log in automatically
   - turn on Remote Login for SSH
   - `brew install node git tailscale`
2. **Admin account, Tailscale:**
   - start the daemon with `--operator=devserver`
   - name the machine
   - add the policy that limits the server to inbound SSH and allows Funnel
   - tag the machine `tag:server` (tagged machines don't have key expiry)
3. **`devserver` user:**
   - set a quick screen lock, and put `/opt/homebrew/bin` on PATH (Homebrew's setup only did that for the admin account)
   - create a **read-only deploy key**, then clone to `~/connectors/canvas-mcp`
   - run `deploy/ctl.sh funnel`, which prints `PUBLIC_URL`, the Azure redirect URI and the connector URL. claude.ai calls the connector from Anthropic's servers, so it needs this public HTTPS address. HTTPS ends on the Mac; Tailscale only relays the traffic.
4. **Gather the secrets:**
   - Azure: add `<PUBLIC_URL>/callback` to the To Do app registration and create a separate client secret
   - Canvas: a personal access token that **expires at the end of the semester**
5. **Fill in `.env`,** then run `deploy/ctl.sh install`. It builds the server, writes a launchd agent with this Mac's paths, and starts it.
6. **Add `<PUBLIC_URL>/mcp`** as a custom connector in claude.ai and sign in with Microsoft.

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
