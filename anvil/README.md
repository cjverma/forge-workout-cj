# Anvil

A macOS app and website blocker with no early exit. You pick a preset and a
duration, confirm, and that's it: there is no stop button, and the daemon that
enforces it has no cancel opcode to call.

Built for one person on one Mac. Menu bar only, no accounts, no network calls,
no telemetry.

> **This is a standalone Swift package living in the FORGE repo temporarily.** It
> was meant for its own repo, but this session's GitHub App cannot create
> repositories. To move it out:
>
> ```sh
> # create an empty cjverma/anvil on github.com first, then:
> git clone https://github.com/cjverma/forge-workout-cj.git
> cd forge-workout-cj && git checkout claude/mac-app-restrict-apps-websites-gfmxuv
> cp -R anvil ~/anvil && cd ~/anvil
> git init -b main && git add -A && git commit -m "Add Anvil"
> git remote add origin git@github.com:cjverma/anvil.git && git push -u origin main
> ```
>
> Nothing in the package refers to its parent directory, so it builds anywhere.

---

## What it actually does

During a session:

- **Blocked apps are quit** the moment they launch, matched by bundle identifier
  so renaming `Slack.app`, copying it to `/tmp`, or running the inner binary
  directly does not get around it.
- **Blocked websites** are nulled in `/etc/hosts`, and any edit to that file is
  reverted within a second.
- **DNS-over-HTTPS and QUIC are disabled** in Chrome, Brave, Edge, Vivaldi and
  Firefox via managed policy files, because a browser resolving over DoH never
  reads `/etc/hosts` at all. Running browsers are restarted once at session start
  so the policies take effect and cached DNS answers are dropped.
- **The packet filter blocks the addresses themselves** on TCP and UDP 80/443,
  which catches direct-IP access and QUIC.
- **Terminal, iTerm, Activity Monitor, System Settings, Console and Script Editor
  are quit for the whole session.** A blocker that leaves a shell open is an
  honour-system blocker for anyone who can type `sudo`.

The block survives quitting the app, force-quitting it, deleting it, killing the
daemon, and rebooting.

## What it cannot do

**On a Mac where you are an admin, no third-party app is unbypassable, and this
one does not pretend to be.** Anyone with your password can act as root. Being
specific about the limits, because a blocker you misunderstand is worse than one
you don't have:

- **Safe Mode ends any session.** Reboot holding Shift and macOS does not load
  third-party LaunchDaemons. This escape is left open deliberately: with the
  escape tools blocked, it is the only thing standing between a bug in this
  software and a Mac you cannot fix.
- **A prepared root command wins the race.** The two daemons resurrect each other
  every second, but `sudo launchctl bootout system/a && sudo launchctl bootout
  system/b` takes both down before either notices. `SIGKILL` cannot be caught by
  any process, ever.
- What actually holds a session together is narrower and more durable than the
  watchdog: **Terminal is dead for the duration**, and **the deadline lives in
  root-owned state**, so tearing the daemons down live only buys freedom until
  the next reboot, when the block re-arms itself.
- A VPN or a browser using a proxy can route around the pf rules.
- Sessions are capped at 24 hours, so a typo cannot cost you a week.

The honest summary: this raises the cost of escaping from one click to a
deliberate reboot into Safe Mode. That gap is the entire product.

---

## Requirements

macOS 13 or later, and the Xcode command line tools (`xcode-select --install`).
No Apple Developer account needed for your own machine.

## Install

Do these in order. **The rehearsal steps are not optional** — escape-tool killing
is unconditional in a real session, so prove the daemon behaves before it can
take your Terminal away.

```sh
git clone https://github.com/cjverma/anvil.git
cd anvil

make test          # 1. pure logic, no root, no side effects
make build         # 2. first real compile
make dry-run       # 3. prints what a session WOULD kill and write. Changes nothing.
make test-session  # 4. real 2-minute session, escape tools exempt, reverts itself
make install       # 5. installs the daemons (asks for your password)

cp -R dist/Anvil.app /Applications/
open /Applications/Anvil.app
```

At step 3, read the kill list carefully. Nothing you need should be on it.

Before your first real session, **reboot into Safe Mode once** (hold Shift at
boot) so the recovery path is one you have actually walked rather than one you
have only read about.

## Uninstall

```sh
sudo ./uninstall.sh
```

It refuses while a session is active. That refusal is friction, not security —
`--force` overrides it. It exists so that removing Anvil is never something you
do without noticing you are doing it.

---

## How it fits together

```
Anvil.app (menu bar, unprivileged)
      │  StartRequest JSON, 4 KB cap, 1 per 5s
      ▼
/var/run/anvil.sock   (root-owned, 0622: connect and write, never read)
      ▼
anvild (root LaunchDaemon) ──┐  owns the deadline, enforces every second
      ▲                      │  mutual resurrection, 1s
      └── anvil-watchdog ────┘
```

`Sources/AnvilCore/` holds everything worth reading:

| File | What it owns |
|---|---|
| `Models.swift` | `SessionPolicy`, the extend-only deadline rule |
| `ProcessScanner.swift` | Bundle-ID matching and the guard list |
| `HostsFile.swift` | The managed `/etc/hosts` section |
| `PFAnchor.swift` | Packet filter rules and DNS resolution |
| `BrowserPolicy.swift` | DoH and QUIC policy files |
| `Enforcer.swift` | One tick of enforcement |

### Why there is no stop button

The deadline lives in `/Library/Application Support/Anvil/state.json`, mode 0600,
root-owned. The only message the daemon accepts is `StartRequest`, and
`SessionPolicy.apply` will only ever return a session whose deadline is later than
the current one, or whose blocklist is wider. There is no opcode for shortening or
cancelling.

So "no early exit" is a property of the protocol rather than a missing button in
the UI. Deleting the app changes nothing.

### Why the guard list looks the way it does

`ProcessScanner.protectedPathPrefixes` covers `/System/Library/`, `/usr/libexec/`
and friends, but deliberately **not** `/System/Applications/`. On macOS 13+ that
is where Terminal, Activity Monitor and System Settings live, so a blanket
`/System/` prefix would quietly turn escape-tool blocking into a no-op while
appearing to work. There are tests asserting Terminal is killable and Dock is not,
which catch a regression in either direction.

### Why pf is on by default

A hosts file only affects name resolution. A browser that already resolved an
address, or one speaking QUIC over UDP 443, never asks again. pf blocks the
addresses themselves.

Because a malformed `/etc/pf.conf` takes the network down with it, every load is
dry-parsed with `pfctl -n -f` first, and any failure restores the backup and runs
the session with hosts-level blocking only. Turn the layer off entirely with
`--no-pf` in the rehearsal modes.

## Troubleshooting

```sh
tail -f /var/log/anvild.log
launchctl print system/com.cjverma.anvild
sudo pfctl -a anvil -t anvil_blocked -T show
```

**A site is still reachable.** Almost always a browser resolving over DoH that has
not been restarted since the policies were written. Quit it fully and reopen.

**The network broke.** pf should never get this far given the dry-parse guard, but
if it does: `sudo pfctl -d`, then `sudo cp "/Library/Application
Support/Anvil/pf.conf.orig" /etc/pf.conf`.

**Everything is wedged.** Reboot into Safe Mode (hold Shift), then
`sudo ./uninstall.sh --force`.
