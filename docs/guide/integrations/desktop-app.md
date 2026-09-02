---
kind: wiki
title: "Desktop app"
status: current
updated: 2026-08-11
---

> Design SSOT: [desktop-app.md](../../architecture/desktop-app.md) — the maintainer page holds the mechanism. Describe the behaviour here; do not re-derive the design.
# Desktop app

An Electron shell that renders the deployed web app and carries a **runner inside it**. Installers for
Linux, macOS and Windows are on
[Releases](https://github.com/everdict/everdict/releases/latest).

Two things it does that a browser tab cannot:

**Pair this machine in one click.** The account page shows "Connect this device", and the app registers
a runner and stores the `rnr_…` token in the OS keychain — no token copied through a clipboard.

**Keep running when the window is closed.** It is tray-resident, so leased jobs continue while you are
doing something else.

## Why you would want it

Because the agent you are evaluating often needs *your* machine: your Claude or ChatGPT login, your VPN,
your SSH keys, a private repo you already have cloned.

```json
{ "runtime": "self:rnr_8812" }
```

Your subscription pays for the tokens, the workspace budget is untouched, and the run records that it
came from a self-hosted runner.

## Full web parity, by construction

The desktop app does not re-implement the UI — it renders the deployed web app. So every feature ships
to both at once, and there is no "the desktop version is behind" state to manage.

Desktop-aware behavior lives in `apps/web` behind `window.everdictDesktop` checks, which is why the
same page can offer one-click pairing in the app and instructions in the browser.

## Headless machines

The desktop app is for machines with a screen. For a CI box or a server, run the same runner from the
CLI:

```bash
everdict runner --pair rnr_… --api-url https://everdict.internal
```

Identical behavior — the app is a convenience around it, not a different mechanism.

## See also

- [Runtime](../concepts/runtime.md) — `self:<id>` and how a runner joins
- [`../../architecture/desktop-app.md`](../../architecture/desktop-app.md) · [`../../architecture/self-hosted-runner.md`](../../architecture/self-hosted-runner.md)
