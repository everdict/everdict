---
kind: wiki
title: "Runner distribution — a one-liner install for a headless machine"
status: current
updated: 2026-09-15
anchors: [apps/cli/src/runner-standalone.ts, apps/cli/esbuild.mjs, apps/cli/sea-build.mjs, packages/application-control/src/runner/runner-install.ts, apps/api/src/api/runner/install.routes.ts]
---
# Runner distribution — a one-liner install for a headless machine

> How a machine that has **never heard of everdict** gets a running `everdict runner`. Registering a shared runner
> prints an attach command; this is the path that makes a command runnable on a bare host.

## The problem

`everdict runner --pair <rnr_…> --api-url <cp>` assumes the `everdict` CLI is on the target's PATH. The CLI is an
unpublished pnpm-workspace package (`@everdict/cli`, `private: true`, `workspace:*` deps), so neither `everdict` nor
`npm i -g @everdict/cli` works on a fresh machine.

## Chosen mechanism — a bundled binary + `curl … | sh` installer

A self-contained `everdict-runner` binary published as a **GitHub Release asset**, fetched by an installer script the
control plane serves with the pairing token embedded, so one paste installs **and** pairs:

```
curl -fsSL "https://<control-plane>/install.sh?token=rnr_…" | sh
```

npm publishing (public conversion + workspace-dep bundling + an npm org) and a Docker-image runner were the
alternatives; the release-asset path needs no external registry account and reuses the esbuild tooling the desktop
already has.

## Why a dedicated runner entry (not the whole CLI)

`apps/cli/src/main.ts` imports `@everdict/orchestrator` (Temporal) for `run`/`worker`/`suite`, and Temporal's
`@temporalio/core-bridge` is a native addon that cannot be bundled into one file. The runner path never touches the
orchestrator, so the distributable is built from a runner-only entry whose graph is `@everdict/self-hosted-runner` +
`@everdict/job-runner`. `runnerCommand` and `parseFlags` live outside `main.ts` so the full CLI and the standalone
entry share them; runner logic stays in `@everdict/self-hosted-runner`.

- `apps/cli/src/runner-command.ts` — the lease-loop wiring (`detectCapabilities` → `superviseLease`), no orchestrator import.
- `apps/cli/src/flags.ts` — the shared flag parser.
- `apps/cli/src/runner-standalone.ts` — the bundle entry; accepts `everdict-runner [runner] --pair … --api-url …`.
- `apps/cli/esbuild.mjs` — bundles the entry to `bundle/everdict-runner.cjs` (CJS, node22), the SEA input
  (`pnpm --filter @everdict/cli bundle`).
- `apps/cli/sea-build.mjs` + `apps/cli/sea-config.json` — turn the bundle into a Node single-executable binary on
  the current platform (postject; ad-hoc re-signed on macOS). `pnpm --filter @everdict/cli package:runner` runs
  build → bundle → SEA.

## The served installer

`GET /install.sh?token=rnr_…[&api-url=…]` (`apps/api/src/api/runner/install.routes.ts`) is unauthenticated by
design — the pairing token is the credential, exactly as the printed attach command already exposes it. The token
is checked against `rnr_[A-Za-z0-9_-]+` before it is embedded, and a missing or malformed one gets a plain-text 400
so `curl -f` fails instead of piping an error page into `sh`. `renderRunnerInstallScript`
(`packages/application-control/src/runner/runner-install.ts`) emits a script that:

1. maps `uname` to `everdict-runner-{linux,darwin}-{x64,arm64}` (Windows is told to download
   `everdict-runner-win-x64.exe` and run it with `--pair`);
2. downloads it from `https://github.com/<EVERDICT_RELEASE_REPO>/releases/latest/download/<asset>` (default repo
   `everdict/everdict`) into `/usr/local/bin`, or `~/.local/bin` when that is not writable;
3. installs a systemd service when run as root on a systemd host, and otherwise runs the runner in the foreground.

`api-url` defaults to the base URL the request came in on.

`POST /workspace/runners` returns both `attachCommand` (for a host that has everdict) and `installCommand` (the
`curl … | sh` one-liner from `renderRunnerInstallCommand`), and the web's shared-runner registration dialog shows both.

## Publishing binaries

⚠️ The `cli-v*` release workflow that built the binaries on a three-OS matrix and attached them to a GitHub Release
was DELETED on 2026-09-11 with every other workflow (declared-limits C3, `docs/sdlc/declared-limits.md`). The
installer still downloads from `releases/latest`, so it works only once the assets under the names above have been
built with `package:runner` on each platform and uploaded to a release by hand.

## Non-goals

- Auto-update of the standalone binary — the desktop runner self-updates; a headless binary is re-installed by its
  operator, and the runner roster's `updateRequired` badge tells them when.
- Signing/notarization, deferred until a certificate exists (same as the desktop release).
