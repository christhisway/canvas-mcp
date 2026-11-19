# canvas-mcp

A personal MCP connector for Canvas LMS. Claude can read your courses, what's due, assignments, grades, announcements and syllabi, and it can submit work, but only after you approve each submission with a one-time code sent to your phone.

It runs as a Node server on a Mac at home, behind an HTTPS tunnel. You connect it in claude.ai by signing in with your Microsoft account, the same way as the Microsoft To Do connector.

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
Claude ──▶ https://<tunnel>/mcp (Bearer token) ──▶ Canvas REST API (your personal access token)
   │
   └─ connect: /authorize (consent page) ──▶ Microsoft sign-in ──▶ /callback ──▶ /token ──▶ token back to Claude
```

- **Access.** The server is its own OAuth 2.1 authorization server, built on the MCP SDK's auth router. To connect, you approve a consent page and sign in with Microsoft. Only accounts in `ALLOWED_EMAILS` get through, and if the list is empty nobody does. Microsoft is used only to check who you are; no Microsoft token is kept. Canvas is reached with your Canvas token, which never leaves the server.
- **Clients.** claude.ai identifies itself with a Client ID Metadata Document, which the server accepts only from hosts in `CIMD_ALLOWED_HOSTS` (default `claude.ai`). Other clients, such as the MCP Inspector, use dynamic client registration.
- **Tokens.** Access tokens last 1 hour. Refresh tokens last 30 days, rotate on every use, and are extended each time they're used. Only SHA-256 hashes are stored, in `DATA_DIR/oauth.json` (mode 0600). `deploy/ctl.sh revoke` signs everything out.

### Submission approval

1. You ask Claude to submit something. It calls `prepare_submission`, which checks the assignment: accepted types, file extensions, attempts left, and lock state. The tool then stores the exact payload on the server and pushes a notification to your phone via [ntfy](https://ntfy.sh) with a summary and a 6-digit code.
2. Claude shows you the preview and asks for the code. The code never appears in any tool result, so Claude can't approve on its own.
3. You type the code. `confirm_submission` submits exactly what was staged. Files are hashed when they're staged, so they can't be swapped afterwards.

Codes expire after 15 minutes and are single-use, and three wrong guesses cancel the submission. Files can only come from `SUBMISSIONS_DIR`; nothing else on the machine can be read. Pending submissions live in memory, so a restart clears them. That's intentional.

## Deploy (on the server Mac)

Do these steps on the Mac that will run the server, not on your dev machine.

### 1. Prepare the Mac

- Install Node 22 and git (`brew install node@22 git`), then sign in to GitHub (`gh auth login`) so you can clone the private repo.
- Keep it awake: `sudo pmset -a sleep 0 disksleep 0 autorestart 1`. To run with the lid closed and no external display, also run `sudo pmset -a disablesleep 1`.
- The server runs as a launchd *agent*, which only runs while your user is logged in. Turn on automatic login: System Settings → Users & Groups. FileVault blocks automatic login, so with FileVault on you have to log in once after every reboot.

### 2. Clone and configure

```bash
git clone https://github.com/christhisway/canvas-mcp.git ~/development/canvas-mcp
cd ~/development/canvas-mcp
cp .env.example .env && chmod 600 .env
```

Fill in `.env`:

- **`CANVAS_BASE_URL` / `CANVAS_TOKEN`.** Use your school's Canvas address. For the token, go to Canvas → Account → Settings → New Access Token.
- **`PUBLIC_URL`.** The tunnel's https address, from step 3.
- **`MS_CLIENT_ID` / `MS_CLIENT_SECRET`.** Reuse the To Do connector's Azure app registration. In the Azure portal → App registrations → that app:
  - **Authentication → add a Web redirect URI:** `<PUBLIC_URL>/callback`
  - **Certificates & secrets → new client secret** just for this server. Copy the **Value**, and note when it expires.
  - **API permissions:** `User.Read` (it's already there).
- **`ALLOWED_EMAILS`.** The Microsoft account you sign in with.
- **`COOKIE_SECRET`.** Generate it with `openssl rand -hex 32`.
- **`NTFY_URL`.** Install the ntfy app, subscribe to a long random topic (`openssl rand -hex 16`), and use `https://ntfy.sh/<topic>`.
- **`SUBMISSIONS_DIR`.** Optional. An iCloud Drive folder lets you add files from your phone.
  - macOS may block a background process from reading iCloud Drive. If `list_submission_files` fails with a permission error, add the `node` binary shown by `deploy/ctl.sh plist` under System Settings → Privacy & Security → Full Disk Access.
  - Turn off "Optimize Mac Storage" for iCloud Drive (or right-click the folder → Keep Downloaded) so the files are really on disk.

### 3. Give it a public HTTPS address

The server only listens on `127.0.0.1:8787`, and a tunnel publishes it. Pick one:

- **Tailscale Funnel** (no domain needed):
  1. Install Tailscale and sign in.
  2. In the admin console, enable HTTPS and Funnel.
  3. Run `tailscale funnel --bg 8787`.

  `PUBLIC_URL` is then `https://<machine>.<tailnet>.ts.net`.
- **Cloudflare Tunnel** (needs a domain on Cloudflare): `brew install cloudflared`, then:

  ```bash
  cloudflared tunnel login
  cloudflared tunnel create canvas-mcp
  cloudflared tunnel route dns canvas-mcp canvas.<your-domain>
  ```

  Point `~/.cloudflared/config.yml` at `http://127.0.0.1:8787` (see [deploy/cloudflared.example.yml](deploy/cloudflared.example.yml)) and run `cloudflared service install`.

### 4. Install and start

```bash
deploy/ctl.sh install
```

This runs `npm ci` and the build, writes `~/Library/LaunchAgents/local.canvas-mcp.plist` with this Mac's paths, starts the server, and checks `/healthz`. Logs go to `~/Library/Logs/canvas-mcp.log`.

Other commands:

```
deploy/ctl.sh update      git pull, npm ci, build, test, restart
deploy/ctl.sh status      launchd state + health check
deploy/ctl.sh logs        follow the log
deploy/ctl.sh restart | stop | start
deploy/ctl.sh revoke      sign out every connected client
```

### 5. Connect

In claude.ai, go to Settings → Connectors → Add custom connector and enter `<PUBLIC_URL>/mcp`. Then approve the consent page and sign in with Microsoft. The connector also works in the Claude mobile app and in Claude Code once it's connected.

If you want a second gate, set `confirm_submission` to "ask before running" in the connector's tool permissions.

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
- **403 "Invalid Host header".** The tunnel sends a hostname other than `PUBLIC_URL`'s.
