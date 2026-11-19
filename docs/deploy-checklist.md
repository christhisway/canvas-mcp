# Deploy checklist: server Mac

Step-by-step setup for the home-server Mac. Tick the boxes as you go; GitHub renders them as checkboxes.

You'll use **two macOS accounts** on that Mac:

- **Your admin account** for system setup (Homebrew, `pmset`, Tailscale, privacy permissions).
- **A dedicated standard user**, called `devserver` below, that runs the connectors and logs in automatically.

[ADR 8](architecture/0008-dedicated-user-filevault-off.md) explains why: with FileVault off, the disk should hold only secrets you can revoke. Other decisions are in [docs/architecture/](architecture/README.md), and background is in the [README](../README.md).

## 0. Before you start

You'll need:

- [ ] **Access to the Azure portal** with the account that owns the To Do connector's app registration.
- [ ] **A Tailscale account** (the free plan is enough).
- [ ] **The ntfy app on your phone.**
- [ ] **The Microsoft account you'll sign in with** when you connect Canvas in claude.ai. Its email goes in `ALLOWED_EMAILS`.
  - It doesn't have to be the account you use for To Do.
  - A personal account is safest, because a school account may be blocked from consenting to a third-party app.
- [ ] **A new, unique password** for the `devserver` user. Automatic login stores it on disk in a recoverable form, so don't reuse it anywhere.
- [ ] **A low-stakes Canvas assignment** (or a sandbox course) for the submission test, and about an hour and a half.

## 1. Admin account: prepare the Mac

- [ ] **Power and updates.** Plug in the power adapter, and install pending macOS updates now.
- [ ] **FileVault is off:** System Settings → Privacy & Security → FileVault.
- [ ] **Keep it awake** and restart it after a power cut:
  ```bash
  sudo pmset -a sleep 0 disksleep 0 autorestart 1
  ```
- [ ] **Lid closed, no external display?** Also run:
  ```bash
  sudo pmset -a disablesleep 1
  ```
- [ ] **Check:** `pmset -g` shows `sleep 0`, and with the lid-closed setting, `SleepDisabled 1`.
- [ ] **Decide how macOS updates install:** System Settings → General → Software Update → Automatic Updates. A restart for an update comes back on its own through automatic login.

## 2. Admin account: create the service user

- [ ] **Create the user.** System Settings → Users & Groups → **Add User**:
  - Type: **Standard** (not Administrator)
  - Name: `devserver`
  - Password: the unique one from step 0
- [ ] **Log in automatically:** System Settings → Users & Groups → **Automatically log in as** → `devserver`.
- [ ] **Turn on SSH.** System Settings → General → Sharing → **Remote Login** on. Under "Allow access for", choose **Only these users**: `devserver` and your admin account.

## 3. Admin account: install tools

- [ ] **Homebrew.** If `brew -v` fails, install it from [brew.sh](https://brew.sh) and run the two `eval` lines it prints.
- [ ] **Install the tools:**
  ```bash
  brew install node git tailscale
  ```
  The `devserver` user can run these but can't install or upgrade them. Upgrades always happen from this account.
- [ ] **Check Node:** `/opt/homebrew/bin/node -v` shows v20.12 or newer.
  - Use plain `node`, not `node@22`. `node@22` is keg-only, so it isn't on PATH, and `deploy/ctl.sh` wouldn't find it.

## 4. Admin account: Tailscale

- [ ] **Start the daemon** (it then runs at every boot) and sign in. `--operator` lets the `devserver` user run `tailscale` commands without `sudo`.
  ```bash
  sudo brew services start tailscale
  sudo tailscale up --operator=devserver
  ```
  Open the link it prints and sign in.
  - To change the operator later, for example after renaming the service user, run `sudo tailscale set --operator=<user>`. Check it with `tailscale debug prefs | grep -i operator`.
- [ ] In the [admin console](https://login.tailscale.com/admin):
  - [ ] **Machines → this Mac → ⋯ → Edit machine name.** Pick something permanent, like `home-server`, because it becomes part of the public URL.
  - [ ] **DNS:** MagicDNS is on, and **HTTPS Certificates** is enabled.
  - [ ] **Access controls:** replace the whole policy with the one below. It lets your own devices reach each other, and reach the server **only over SSH**. It gives the server no access to anything else, and allows Funnel on it.
    - **Don't merge it into the default policy.** The default's `{"src": ["*"], "dst": ["*"], "ip": ["*"]}` grant allows everything, and grants only ever *add* access. Keeping that line would cancel the isolation.
    - The `ssh` block is the default's Tailscale SSH rule, kept unchanged. It doesn't apply to the server, which uses macOS Remote Login on port 22.
    - **Replace `YOUR-TAILSCALE-LOGIN`** (twice, in `tests`) with your login exactly as it appears on the admin console's **Users** page. The `tests` run on every save, so the editor refuses a policy that breaks the isolation.

    ```jsonc
    {
    	// Tags, and who may apply them.
    	"tagOwners": {
    		"tag:server": ["autogroup:admin"],
    	},

    	"grants": [
    		// Your own devices can reach each other.
    		{"src": ["autogroup:member"], "dst": ["autogroup:member"], "ip": ["*"]},
    		// ...and the home server, but only over SSH (macOS Remote Login).
    		// Nothing grants tag:server access to anything, so the server can't reach your devices.
    		{"src": ["autogroup:member"], "dst": ["tag:server"], "ip": ["tcp:22"]},
    	],

    	// Allow Funnel (the public HTTPS address) on the server.
    	"nodeAttrs": [
    		{"target": ["tag:server"], "attr": ["funnel"]},
    	],

    	// Tailscale SSH, unchanged from the default. Covers your own untagged devices only.
    	"ssh": [
    		{
    			"action": "check",
    			"src":    ["autogroup:member"],
    			"dst":    ["autogroup:self"],
    			"users":  ["autogroup:nonroot", "root"],
    		},
    	],

    	// Checked on every save; the save fails if any of these doesn't hold.
    	"tests": [
    		// You can SSH to the server, but reach nothing else on it.
    		{"src": "YOUR-TAILSCALE-LOGIN", "accept": ["tag:server:22"], "deny": ["tag:server:8787"]},
    		// The server can't reach your devices.
    		{"src": "tag:server", "deny": ["YOUR-TAILSCALE-LOGIN:22"]},
    	],
    }
    ```
    - If the editor rejects only the `tests` block, delete it and save without it; the rest of the policy doesn't depend on it.
    - Save the policy **before** tagging the machine. `tag:server` can't be applied until `tagOwners` defines it.
  - [ ] **Machines → this Mac → ⋯ → Edit ACL tags → add `tag:server`.** Tagged machines also don't have key expiry, so the server won't drop off Tailscale after 180 days.
- [ ] **Check:** `tailscale status` shows this Mac online.

## 5. `devserver` user: set up the account

Log out of the admin account and log in as `devserver`. Do every step from here on as `devserver`, unless a step says otherwise.

- [ ] **Screen lock:**
  - System Settings → Lock Screen: **Turn display off when inactive** after 1–2 minutes, and **Require password** immediately.
  - Don't sign in to an Apple ID on this account.
- [ ] **Put Homebrew's tools on this account's PATH.** Step 3's `eval` lines only went into the admin account's shell profile, so here `tailscale` and `node` would otherwise be "not found":
  ```bash
  echo 'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"' >> ~/.zprofile
  source ~/.zprofile
  tailscale version && node -v
  ```
  - If either command still isn't found, it isn't installed. Go back to step 3 on the admin account.
- [ ] **Create a read-only deploy key for the repo:**
  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/canvas-mcp-deploy -N "" -C "canvas-mcp deploy (home-server)"
  cat ~/.ssh/canvas-mcp-deploy.pub
  ```
- [ ] **Add the key to GitHub.** On GitHub → christhisway/canvas-mcp → Settings → Deploy keys → **Add deploy key**. Paste the public key and leave **Allow write access unticked**.
  - Or, from your laptop: `gh repo deploy-key add <file>.pub -R christhisway/canvas-mcp`
- [ ] **Tell SSH to use that key for this repo.** The file is `/Users/devserver/.ssh/config`. It probably doesn't exist yet, and Finder hides `~/.ssh`, so add the block from Terminal. This creates the file, or appends to it if it exists:
  ```bash
  cat >> ~/.ssh/config <<'EOF'

  Host github-canvas-mcp
    HostName github.com
    User git
    IdentityFile ~/.ssh/canvas-mcp-deploy
    IdentitiesOnly yes
  EOF
  chmod 600 ~/.ssh/config
  ```
  - SSH ignores a config file that other users can write to, hence the `chmod`.
  - To edit it later, use `nano ~/.ssh/config`. Avoid TextEdit, which can switch to rich text or add `.txt`.
- [ ] **Test the key:**
  ```bash
  ssh -T github-canvas-mcp
  ```
  - On the first connection, compare the host fingerprint against [GitHub's published fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) before typing `yes`.
  - It should answer "Hi christhisway/canvas-mcp! You've successfully authenticated, but GitHub does not provide shell access."
  - `Permission denied (publickey)` means the key isn't on GitHub yet, or the config points at the wrong file. Check with `ls -l ~/.ssh`.
- [ ] **Clone the repo and create the config file:**
  ```bash
  mkdir -p ~/connectors
  git clone github-canvas-mcp:christhisway/canvas-mcp.git ~/connectors/canvas-mcp
  cd ~/connectors/canvas-mcp
  cp .env.example .env && chmod 600 .env
  ```

## 6. `devserver` user: turn on Funnel

- [ ] Run:
  ```bash
  deploy/ctl.sh funnel
  ```
  - If it says access denied, run `sudo tailscale funnel --bg 8787` from the admin account (over SSH works), then run `deploy/ctl.sh funnel` again here.
  - If Tailscale prints a link to enable Funnel, open it, approve, and run the command again.
  - Ignore the `PUBLIC_URL` mismatch warning for now.
- [ ] **Write down the three lines it prints:**
  - `PUBLIC_URL=https://<machine>.<tailnet>.ts.net`
  - the Azure redirect URI, `…/callback`
  - the connector URL, `…/mcp`

## 7. Azure (any machine with a browser)

[portal.azure.com](https://portal.azure.com) → Microsoft Entra ID → App registrations → the **To Do connector's** app:

- [ ] **Authentication → Web → Add URI:** the redirect URI from step 6. Click **Save**.
- [ ] **Certificates & secrets → New client secret.**
  - Name it `canvas-mcp`.
  - Copy the **Value** (not the Secret ID) right away; it's only shown once.
- [ ] **Note the secret's expiry date** and set a reminder a week before it.
- [ ] **Overview:** copy the **Application (client) ID**.
- [ ] **API permissions:** confirm Microsoft Graph `User.Read` is listed.

## 8. Canvas token (any browser signed in to Canvas)

- [ ] **Note the Canvas address** from your browser's address bar, for example `https://<something>.instructure.com`. That's `CANVAS_BASE_URL`.
- [ ] **Create the token.** Canvas → Account → Settings → **+ New Access Token**:
  - Purpose: "Claude connector".
  - **Expires: the last day of the semester.** This limits the damage if the Mac is ever stolen.
  - Copy the token now; Canvas won't show it again.
- [ ] **Set a reminder** for the day before it expires, to create the next one.

## 9. ntfy (approval codes)

- [ ] **Generate a topic name:** `openssl rand -hex 16`. Anyone who knows the topic can read your approval codes.
- [ ] **Subscribe your phone:** in the ntfy app, tap **+** and subscribe to that topic on ntfy.sh.
- [ ] **Send a test:** `curl -d "canvas-mcp test" https://ntfy.sh/<topic>`. Your phone should show it within a few seconds.

## 10. Submissions folder

The default is `./submissions` inside the checkout (`~/connectors/canvas-mcp/submissions`). From your laptop, copy files in over Tailscale:

```bash
scp report.pdf devserver@<machine>:connectors/canvas-mcp/submissions/
```

- [ ] **Create the folder:** `mkdir -p ~/connectors/canvas-mcp/submissions`

**Optional: add files from your phone.** This route keeps your own Apple ID off the server: a separate Apple ID on the `devserver` user sees only one folder you share with it.

- [ ] **Create a new Apple ID** used only for this. It may ask for a phone number.
- [ ] **On the `devserver` user, sign in to iCloud with it.**
  - Turn on only **iCloud Drive**, with Optimize Mac Storage **off**.
  - Turn off Keychain, Photos and everything else.
- [ ] **On your phone, share a folder with it.** In the Files app → iCloud Drive, create `Canvas Submissions`, then long-press → **Share**. Only invited people get access, with **Can make changes**. Invite the new Apple ID.
- [ ] **On the server, accept the invite.** The folder then appears at `~/Library/Mobile Documents/com~apple~CloudDocs/Canvas Submissions`.
  - Use that full `/Users/devserver/...` path for `SUBMISSIONS_DIR`. `.env` doesn't expand `~/`, and spaces are fine without quotes.

## 11. Fill in `.env`

Edit `~/connectors/canvas-mcp/.env`, for example with `nano .env`:

| Key | Value |
|---|---|
| `CANVAS_BASE_URL` | from step 8 |
| `CANVAS_TOKEN` | from step 8 |
| `PUBLIC_URL` | from step 6 (no trailing slash) |
| `MS_CLIENT_ID` | Application (client) ID from step 7 |
| `MS_CLIENT_SECRET` | secret **Value** from step 7 |
| `MS_TENANT` | leave as `common` |
| `ALLOWED_EMAILS` | the email of the Microsoft account from step 0 |
| `COOKIE_SECRET` | output of `openssl rand -hex 32` |
| `NTFY_URL` | `https://ntfy.sh/<topic>` from step 9 |
| `SUBMISSIONS_DIR` | leave `./submissions`, or the full shared-folder path from step 10 |
| `TIME_ZONE` | leave as `America/New_York` |

- [ ] All keys are filled in. `deploy/ctl.sh install` refuses to run while any placeholder is left.

## 12. Install and start

- [ ] **Install:**
  ```bash
  deploy/ctl.sh install
  ```
  Expect `healthy on 127.0.0.1:8787 (public: https://…/mcp)`. There should be no admin-account warning and no `PUBLIC_URL` warning.
- [ ] **Check status:** `deploy/ctl.sh status` shows `state = running` and healthy.
- [ ] **From outside your network** (your phone with Wi-Fi off), open:
  - [ ] `<PUBLIC_URL>/healthz`, which should show `{"ok":true}`
  - [ ] `<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp`, which should be JSON naming `<PUBLIC_URL>/mcp`

  A brand-new Funnel hostname can take a few minutes to resolve.

## 13. Connect in claude.ai

- [ ] **Keep the log open on the server:** `deploy/ctl.sh logs` (over SSH works).
- [ ] **Add the connector.** In claude.ai → Settings → Connectors → **Add custom connector**: name it "Canvas", enter the connector URL from step 6, then click **Connect**.
- [ ] **Sign in.** Approve the consent page and sign in with the Microsoft account from step 0. You should land back in claude.ai, connected.
- [ ] **Check the log** shows `Sign-in approved for <your email>`.
  - If it shows `CIMD fetch failed`, set `CIMD_ALLOWED_HOSTS=none` in `.env`, run `deploy/ctl.sh restart`, and connect again.
- [ ] **Optional:** set the connector's `confirm_submission` permission to **Ask**.

## 14. Try every read tool

In a new chat with the connector enabled, ask:

- [ ] "List my Canvas courses" (`list_courses`)
- [ ] "What's due in the next two weeks?" (`get_upcoming`). Check that quizzes and discussions look right.
- [ ] "Show the assignments for <course>" (`list_assignments`), then one in detail (`get_assignment`)
- [ ] "What's my grade in <course>?" (`get_grades`)
- [ ] "Any new announcements?" (`list_announcements`)
- [ ] "Show the syllabus for <course>" (`get_syllabus`)

Paste any errors or odd output into a Claude Code session in this repo. These tools have never run against real Canvas.

## 15. Submission test (low stakes)

- [ ] **Add a test file** to the submissions folder, then ask "What files are ready to submit?" (`list_submission_files`).
  - If it fails with a permission error on the shared iCloud folder, use the admin account to add `/opt/homebrew/bin/node` under System Settings → Privacy & Security → **Full Disk Access**. The real binary is under `/opt/homebrew/Cellar/node/…`; add that too if the first doesn't take. Then run `deploy/ctl.sh restart`.
- [ ] **Ask Claude to submit it** to the practice assignment. Check the preview, and check that the code arrives on your phone but **doesn't** appear in the chat.
- [ ] **Type the code.** Claude reports `submitted`, and the submission shows in Canvas.
  - If the upload fails, keep the log lines; the storage-upload step is the least-tested part.

## 16. Resilience and isolation checks

- [ ] **Reboot test.** Run `sudo reboot` from the admin account. Once it's back, with no one touching it:
  - it's logged in as `devserver` and the screen locks
  - `<PUBLIC_URL>/healthz` works from your phone
  - the connector still answers in claude.ai
- [ ] **Refresh test.** More than an hour after connecting, use the connector again. It should work without asking you to reconnect, and the log shows a `POST /token`.
- [ ] **SSH from your laptop** (with Tailscale installed there): `ssh devserver@<machine>`, then `cd ~/connectors/canvas-mcp && deploy/ctl.sh status`.
- [ ] **Isolation.** From the server, try `ssh <you>@<laptop>` or `curl http://<laptop>:<some open port>`. It should time out, because the server can't reach your other devices.

## 17. Reminders to set

- [ ] **Azure client secret expiry** (step 7). To rotate: create a new secret, update `MS_CLIENT_SECRET`, then `deploy/ctl.sh restart`.
- [ ] **Canvas token expiry** at the end of the semester (step 8). To rotate: create a new token, update `CANVAS_TOKEN`, then `deploy/ctl.sh restart`.

## Day-to-day

As `devserver`, in `~/connectors/canvas-mcp`:

| Task | Command |
|---|---|
| Deploy new code after a push | `deploy/ctl.sh update` |
| Is it up? | `deploy/ctl.sh status` |
| Watch the log | `deploy/ctl.sh logs` |
| Restart | `deploy/ctl.sh restart` |
| Sign out every client (suspected leak) | `deploy/ctl.sh revoke`, then reconnect in claude.ai |
| Funnel address / mismatch check | `deploy/ctl.sh funnel` |
| Upgrade Node | `brew upgrade node` **from the admin account**, then `deploy/ctl.sh restart` here |

## If the Mac is lost or stolen

Do these from any other device, in this order:

1. **Tailscale admin console:** remove the machine. This cuts it off the tailnet and turns off Funnel.
2. **Canvas** → Account → Settings → Approved Integrations: delete the "Claude connector" token.
3. **Azure portal** → the app → Certificates & secrets: delete the `canvas-mcp` secret.
4. **GitHub** → christhisway/canvas-mcp → Settings → Deploy keys: delete the server's key.
5. **If you set up the shared iCloud folder:** stop sharing it with the server's Apple ID.

Then set up a new machine from the top of this checklist. Connecting again issues new tokens, and anything the old server issued is useless without it.
