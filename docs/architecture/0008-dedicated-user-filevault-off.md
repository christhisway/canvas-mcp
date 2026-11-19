# 8. Run connectors as a dedicated standard user, with FileVault off and automatic login

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

The server runs as a launchd agent, which only runs while a user is logged in ([ADR 2](0002-node-on-home-server.md)). To come back after a power cut or crash without anyone present, the Mac needs automatic login. macOS doesn't allow automatic login while FileVault is on, so the owner turned FileVault off.

FileVault protects data only while the Mac is off, so turning it off doesn't change the internet-facing risk. The sign-in, the allowlist and the phone code are unaffected. What changes is physical access: anyone who powers the Mac on is logged in, and automatic login stores the user's password on disk in a recoverable form. What an attacker would find on the disk:

- **`CANVAS_TOKEN`.** Full Canvas access that talks to Canvas directly, **bypassing the sign-in and the phone code**. This is the main thing at risk.
- **`MS_CLIENT_SECRET`.** Lets someone act as the Azure app shared with the To Do connector, but not as the owner's account.
- **The Tailscale machine key.** By default it can reach every device on the tailnet, and key expiry is off.
- **A GitHub login,** if `gh auth login` were used, giving access to every private repo.
- **Whatever the logged-in user carries:** Apple ID data (iCloud Drive, Messages), the keychain, browser sessions.

Later connectors on this Mac may need the owner's own Apple ID data on the disk (for example Messages or iCloud Drive), which would raise the stakes a lot.

## Decision

Keep FileVault off and automatic login on, and **keep the disk boring**:

- **A dedicated standard (non-admin) macOS user** runs all connectors and is the automatic-login user.
  - It has a unique password and isn't signed in to the owner's Apple ID.
  - It locks its screen immediately once the display turns off, which happens after a minute or two.
  - Admin tasks (Homebrew, `pmset`, the Tailscale daemon, privacy permissions) are done from a separate admin account.
- **A read-only deploy key** per connector repo is used instead of a `gh` login, so the server can pull its own repo and nothing else.
- **The Canvas token expires** at the end of each semester and is rotated then.
- **The server is tagged `tag:server` in Tailscale,** with a policy that lets the owner's devices reach it over SSH but gives it no access to anything else on the tailnet. Tagged devices don't have key expiry.
- **Submission files** go in a local folder, copied in over SSH. For adding files from the phone, there's an optional route: a separate, throwaway Apple ID on the server user that sees only one folder shared from the owner's iCloud Drive.

**Revisit when** the first connector needs the owner's own Apple ID data (for example Messages or iCloud Drive). At that point, supersede this ADR. The likely plan:

- Turn FileVault back on (it encrypts in the background) and use `sudo fdesetup authrestart` for planned restarts. Accept that an unplanned reboot waits for a manual login.
- Give the connector that needs Full Disk Access its own copy of `node`, because the permission applies to a program, not to one connector.

## Consequences

- **A stolen Mac exposes only revocable secrets.** The response:
  - remove the machine in the Tailscale console
  - revoke the Canvas token (Canvas → Account → Settings → Approved Integrations)
  - delete the Azure client secret
  - delete the repo's deploy key
- **Admin tasks need the admin account,** because the service user can't `sudo` or `brew install`. `deploy/ctl.sh` warns if it's run from an admin account.
- **Adding files from the phone is less convenient** than an iCloud folder signed in with the owner's own Apple ID, unless the shared-folder route is set up.
- **Every future connector runs under the same service user,** each with its own checkout, `.env`, port, launchd label and log, plus its own deploy key and `~/.ssh/config` entry.
