# Deploy checklist: server Mac

Step-by-step setup for the home-server Mac. Do everything here on **that** Mac unless a step says otherwise. Tick the boxes as you go; GitHub renders them as checkboxes.

Why it's built this way: [docs/architecture/](architecture/README.md). Background on each piece: [README](../README.md).

## 0. Before you start

You'll need these along the way:

- [ ] **Access to the Azure portal** with the account that owns the To Do connector's app registration.
- [ ] **A Tailscale account** (sign up at tailscale.com; the free plan is enough).
- [ ] **The ntfy app on your phone**, from the App Store.
- [ ] **The Microsoft account email you use for the To Do connector.** It goes in `ALLOWED_EMAILS`.
- [ ] **About an hour,** and a low-stakes Canvas assignment (or a sandbox course) for the submission test at the end.

## 1. Prepare the Mac

- [ ] Plug in the power adapter, and install pending macOS updates now so they don't restart the Mac mid-setup.
- [ ] Keep it awake and have it restart after a power cut:
  ```bash
  sudo pmset -a sleep 0 disksleep 0 autorestart 1
  ```
- [ ] **Lid closed, no external display?** Also run:
  ```bash
  sudo pmset -a disablesleep 1
  ```
- [ ] Check the settings took: `pmset -g` shows `sleep 0`. With the lid-closed setting, it also shows `SleepDisabled 1`.
- [ ] **Turn on automatic login:** System Settings → Users & Groups → Automatically log in as → your user.
  - The server runs as a launchd *agent*, which only runs while you're logged in.
  - This option is greyed out while FileVault is on. Either turn FileVault off, or accept logging in by hand after every reboot.
- [ ] **Decide how macOS updates install:** System Settings → General → Software Update → Automatic Updates. With automatic login on, a restart for an update recovers on its own. With FileVault on, it waits for you to log in.
- [ ] **Turn on SSH,** so you can manage the server from your laptop over Tailscale: System Settings → General → Sharing → Remote Login.

## 2. Install tools

- [ ] **Install Homebrew** if `brew -v` fails: follow the one-line installer on [brew.sh](https://brew.sh), then run the two `eval` lines it prints.
- [ ] Install the tools:
  ```bash
  brew install node git gh tailscale
  ```
- [ ] **Check Node.** `node -v` should show v20.12 or newer, and `which node` should be `/opt/homebrew/bin/node`.
  - Plain `node` is used on purpose. `node@22` is keg-only, so it isn't on PATH, and `deploy/ctl.sh` would fail to find it.
- [ ] Sign in to GitHub so you can clone the private repo:
  ```bash
  gh auth login
  gh auth setup-git
  ```

## 3. Tailscale

- [ ] Start the daemon (it then starts at every boot, even before login) and sign in:
  ```bash
  sudo brew services start tailscale
  sudo tailscale up --operator=$USER
  ```
  Open the link it prints and sign in. `--operator` lets later `tailscale` commands run without `sudo`. If one still says access denied, prefix it with `sudo`.
- [ ] Check `tailscale status`: this Mac should be listed and online.
- [ ] **In the [admin console](https://login.tailscale.com/admin/machines), open this machine's ⋯ menu:**
  - [ ] **Edit machine name** to something permanent, for example `home-server`. The name becomes part of the public URL, and changing it later means redoing the Azure redirect URI and the claude.ai connector.
  - [ ] **Disable key expiry.** By default the machine's key expires after 180 days. When it does, the Mac drops off Tailscale and the connector goes down without warning.

## 4. Clone the repo

- [ ] Clone it and create the config file:
  ```bash
  git clone https://github.com/christhisway/canvas-mcp.git ~/development/canvas-mcp
  cd ~/development/canvas-mcp
  cp .env.example .env && chmod 600 .env
  ```

## 5. Turn on Funnel

- [ ] Run:
  ```bash
  deploy/ctl.sh funnel
  ```
  - The first time, Tailscale may print a link to enable HTTPS certificates and Funnel for your tailnet. Open it, approve, and run the command again.
  - Ignore the `PUBLIC_URL` mismatch warning at the end for now; `.env` isn't filled in yet.
- [ ] **Write down the three lines it prints:**
  - `PUBLIC_URL=https://<machine>.<tailnet>.ts.net`
  - the Azure redirect URI, `…/callback`
  - the connector URL, `…/mcp`

## 6. Azure (any machine with a browser)

Go to [portal.azure.com](https://portal.azure.com) → Microsoft Entra ID → App registrations → the **To Do connector's** app.

- [ ] **Authentication → Web → Add URI:** paste the redirect URI from step 5, then click Save.
- [ ] **Certificates & secrets → New client secret.**
  - Name it `canvas-mcp` (separate from the To Do connector's secret).
  - Copy the **Value** (not the Secret ID) right away; it's only shown once.
- [ ] **Note the secret's expiry date** and set a reminder a week before it, for example a task in To Do.
- [ ] **Overview:** copy the **Application (client) ID**.
- [ ] **API permissions:** confirm Microsoft Graph `User.Read` is listed (it already is for To Do).

## 7. Canvas token (any browser signed in to Canvas)

- [ ] Note the Canvas address from your browser's address bar, for example `https://<something>.instructure.com`. That's `CANVAS_BASE_URL`, without any path.
- [ ] Go to Canvas → Account → Settings → **+ New Access Token**.
  - Purpose: "Claude connector". Set an expiry date if you want one, and if you do, add a reminder.
  - Copy the token now; Canvas won't show it again.

## 8. ntfy (approval codes)

- [ ] Generate a long random topic name. Anyone who knows it can read your approval codes.
  ```bash
  openssl rand -hex 16
  ```
- [ ] In the ntfy app, tap **+**, enter the topic, and subscribe on the default server (ntfy.sh).
- [ ] Send a test. Your phone should show a notification within a few seconds.
  ```bash
  curl -d "canvas-mcp test" https://ntfy.sh/<topic>
  ```

## 9. Submissions folder (optional: iCloud Drive)

Skip this to use `./submissions` inside the repo.

- [ ] **On the server Mac,** System Settings → Apple Account → iCloud → iCloud Drive is on. Under its options, **Optimize Mac Storage** is off, so files are really on disk.
- [ ] Create the folder:
  ```bash
  mkdir -p ~/Library/Mobile\ Documents/com~apple~CloudDocs/Canvas\ Submissions
  ```
- [ ] **Find the full path** with `echo ~/Library/Mobile\ Documents/com~apple~CloudDocs/Canvas\ Submissions`. `.env` needs that full `/Users/...` path, because it doesn't expand `~/`. The folder name's spaces are fine as-is, with no quotes.

## 10. Fill in `.env`

Edit `~/development/canvas-mcp/.env` (for example `nano .env`):

| Key | Value |
|---|---|
| `CANVAS_BASE_URL` | from step 7 |
| `CANVAS_TOKEN` | from step 7 |
| `PUBLIC_URL` | from step 5 (no trailing slash) |
| `MS_CLIENT_ID` | Application (client) ID from step 6 |
| `MS_CLIENT_SECRET` | secret **Value** from step 6 |
| `MS_TENANT` | leave as `common` |
| `ALLOWED_EMAILS` | your Microsoft account email |
| `COOKIE_SECRET` | output of `openssl rand -hex 32` |
| `NTFY_URL` | `https://ntfy.sh/<topic>` from step 8 |
| `SUBMISSIONS_DIR` | full path from step 9, or leave `./submissions` |
| `TIME_ZONE` | leave as `America/New_York` |

- [ ] All keys filled in. `deploy/ctl.sh install` refuses to run while any placeholder is left.

## 11. Install and start

- [ ] Run:
  ```bash
  deploy/ctl.sh install
  ```
  Expect `healthy on 127.0.0.1:8787 (public: https://…/mcp)` and no `PUBLIC_URL` warning.
- [ ] Check `deploy/ctl.sh status`: `state = running` and healthy.
- [ ] **From outside your network** (your phone with Wi-Fi off), open:
  - [ ] `<PUBLIC_URL>/healthz`, which should show `{"ok":true}`
  - [ ] `<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp`, which should be JSON naming `<PUBLIC_URL>/mcp`

  A brand-new Funnel hostname can take a few minutes to resolve.

## 12. Connect in claude.ai

- [ ] **On the server (or over SSH),** keep the log open: `deploy/ctl.sh logs`
- [ ] In claude.ai, go to Settings → Connectors → **Add custom connector**. Name it "Canvas", give it the connector URL from step 5, then click **Connect**.
- [ ] Approve the consent page and sign in with your Microsoft account. You should land back in claude.ai, connected.
- [ ] The log shows `Sign-in approved for <your email>`.
  - If you see `CIMD fetch failed`, set `CIMD_ALLOWED_HOSTS=none` in `.env`, run `deploy/ctl.sh restart`, and connect again.
- [ ] **Optional second gate:** set the connector's `confirm_submission` permission to **Ask**.

## 13. Try every read tool

In a new chat with the connector enabled, ask:

- [ ] "List my Canvas courses" (`list_courses`)
- [ ] "What's due in the next two weeks?" (`get_upcoming`). Check that quizzes and discussions look right.
- [ ] "Show the assignments for <course>" (`list_assignments`), then one in detail (`get_assignment`)
- [ ] "What's my grade in <course>?" (`get_grades`)
- [ ] "Any new announcements?" (`list_announcements`)
- [ ] "Show the syllabus for <course>" (`get_syllabus`)

Paste any errors or odd output into a Claude Code session in this repo; these are the parts never tested against real Canvas.

## 14. Submission test (low stakes)

- [ ] Put a test file in the submissions folder, then ask "What files are ready to submit?" (`list_submission_files`).
  - If it fails with a permission error, go to System Settings → Privacy & Security → **Full Disk Access**, add `/opt/homebrew/bin/node` (the real binary is under `/opt/homebrew/Cellar/node/…`; add both if one doesn't take), then run `deploy/ctl.sh restart`.
- [ ] Ask Claude to submit it to the practice assignment. Check the preview, and check that the phone gets the code while the code **doesn't** appear in the chat.
- [ ] Type the code. Claude reports `submitted`, and the submission shows in Canvas.
  - If the upload fails, keep the log lines; the storage-upload step is the least-tested part.

## 15. Resilience checks

- [ ] **Reboot test.** Run `sudo reboot`. After it comes back, with no one touching it, `<PUBLIC_URL>/healthz` works from your phone, and the connector still answers in claude.ai.
- [ ] **Refresh test.** More than an hour after connecting, use the connector again. It should work without asking you to reconnect, and the log shows a `POST /token`.
- [ ] **SSH from your laptop** (with Tailscale installed there): `ssh <user>@<machine-name>`, then run `cd ~/development/canvas-mcp && deploy/ctl.sh status`.

## 16. Reminders to set

- [ ] The Azure client secret's expiry date (from step 6). Rotate it by creating a new secret, updating `MS_CLIENT_SECRET`, and running `deploy/ctl.sh restart`.
- [ ] The Canvas token's expiry, if you set one. Rotate it by creating a new token, updating `CANVAS_TOKEN`, and restarting.
- [ ] Tailscale key expiry is disabled (step 3), so there's nothing to set for it.

## Day-to-day

| Task | Command (in `~/development/canvas-mcp`) |
|---|---|
| Deploy new code after a push | `deploy/ctl.sh update` |
| Is it up? | `deploy/ctl.sh status` |
| Watch the log | `deploy/ctl.sh logs` |
| Restart | `deploy/ctl.sh restart` |
| Sign out every client (suspected leak) | `deploy/ctl.sh revoke`, then reconnect in claude.ai |
| Funnel address / mismatch check | `deploy/ctl.sh funnel` |
