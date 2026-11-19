# 12. FileVault on, no automatic login; `devserver` signs in to the owner's Apple ID

- **Status:** Accepted
- **Date:** 2026-11-19
- **Supersedes:** [ADR 8](0008-dedicated-user-filevault-off.md)

## Context

[ADR 8](0008-dedicated-user-filevault-off.md) turned FileVault off so the Mac could log in automatically after a power cut. It kept the disk "boring" by giving `devserver` no Apple ID, and said to supersede it when the first connector needed the owner's own Apple ID data.

That connector now exists: a Messages connector, also running as `devserver` on this Mac. It reads the local Messages database, which only exists on an account signed in to the owner's Apple ID with Messages in iCloud on. It also needs that account's GUI session. The owner chose to keep every connector on `devserver` rather than add a second macOS user. With FileVault off, a stolen Mac would give away the owner's whole text history, and a signed-in Mac that can receive Apple ID verification codes.

## Decision

- **FileVault is on.** Turn it on from the admin account. `devserver` is a FileVault-enabled user, so unlocking the disk at startup logs it in.
- **Automatic login is off.** macOS doesn't allow it while FileVault is on.
- **Planned restarts** use `sudo fdesetup authrestart` from the admin account, over SSH if needed. The disk unlocks once for that restart, and `devserver` logs in without anyone present.
- **macOS updates download automatically but are installed by hand,** followed by `authrestart`. Otherwise an update's own restart would wait at the unlock screen.
- **`devserver` signs in to iCloud with the owner's Apple ID,** with only Messages and Find My turned on. Find My allows a remote lock or erase.
- **Unchanged from ADR 8:**
  - `devserver` is a dedicated standard (non-admin) user, and the admin account does everything needing `sudo` or Homebrew.
  - The screen locks as soon as the display turns off.
  - Each connector repo has a read-only deploy key, with no `gh` login.
  - The server is tagged `tag:server` in Tailscale, and the Canvas token expires each semester.

## Consequences

- **A powered-off or stolen Mac is encrypted at rest.** That covers `CANVAS_TOKEN`, `MS_CLIENT_SECRET`, the Tailscale node keys and the owner's Apple ID data.
- **An unplanned restart (power cut, crash) takes every connector offline** until someone unlocks the disk. macOS 26 can unlock FileVault over SSH, but Tailscale is on the locked disk, so that needs the home network or another always-on device at home on the tailnet. `pmset autorestart` still powers the Mac back on, but it now stops at the unlock screen.
- **The reboot test changes.** Use `sudo fdesetup authrestart` and expect `devserver` to come back logged in. Separately, check that a plain restart waits for an unlock, and that unlocking (locally, or over SSH from the home network) brings the LaunchAgents back.
- **The Mac becomes one of the owner's trusted Apple ID devices.** If it's lost or stolen, also remove it from the Apple ID's device list, and use Find My to lock or erase it.
- **The `devserver` password is no longer stored on disk** for automatic login. It's still a unique password, and it now also unlocks the disk.
- **Changing an existing server** (set up under ADR 8):
  1. In the admin account, check `sysadminctl -secureTokenStatus devserver` shows ENABLED. If it doesn't, give it one with `sysadminctl -secureTokenOn devserver -password - -adminUser <admin> -adminPassword -`.
  2. Turn on FileVault (System Settings → Privacy & Security → FileVault) and keep the recovery key somewhere off the Mac.
  3. Confirm automatic login turned itself off.
  4. Test with `sudo fdesetup authrestart`.
