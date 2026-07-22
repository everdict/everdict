# Runner distribution — a one-liner install for a headless machine

> How a machine that has **never heard of everdict** gets a running `everdict runner`. The workspace
> "Register shared runner" dialog (and headless personal pairing) prints an attach command; this is the
> path that makes that command actually runnable on a bare host.

## The problem

`everdict runner --pair <rnr_…> --api-url <cp>` assumes the `everdict` CLI is on the target's PATH. The
CLI is an unpublished pnpm-workspace package (`@everdict/cli`, `private: true`, `workspace:*` deps), so
neither `everdict` nor `npm i -g @everdict/cli` works on a fresh machine. The honest short-term UX (a
setup-prerequisite link + the corrected command) shipped first; this doc is the real bootstrap.

## Chosen mechanism — bundled binary + `curl … | sh` installer

A self-contained `everdict-runner` binary published as a **GitHub Release asset** (mirrors the
`desktop-v*` release), fetched by an installer script the control plane serves with the pairing token
embedded, so one paste installs **and** pairs:

```
curl -fsSL https://<control-plane>/install.sh?token=rnr_… | sh
```

npm publishing (public conversion + workspace-dep bundling + an npm org) and a Docker-image runner were
the alternatives; the release-asset path needs no external registry account and reuses the existing
release + esbuild tooling.

## Why a dedicated runner entry (not the whole CLI)

`apps/cli/src/main.ts` imports `@everdict/orchestrator` (Temporal) for `run`/`worker`/`suite`. Temporal's
`@temporalio/core-bridge` is a native Rust addon that **cannot be bundled** into a single file. The runner
path never touches the orchestrator, so the distributable is built from a **runner-only entry** that
imports only `@everdict/self-hosted-runner` + `@everdict/job-runner` — the same graph the desktop already
bundles with esbuild. `runnerCommand` + `parseFlags` were extracted out of `main.ts` so both the full CLI
and the standalone entry reuse them (runner LOGIC still lives in `@everdict/self-hosted-runner`).

- `apps/cli/src/runner-command.ts` — the lease-loop wiring (`detectCapabilities` → `superviseLease`), no orchestrator import.
- `apps/cli/src/runner-standalone.ts` — the bundle entry; accepts `everdict-runner [runner] --pair … --api-url …`.
- `apps/cli/esbuild.mjs` — bundles `runner-standalone.ts` → `bundle/everdict-runner.cjs` (CJS, node22), the SEA input. `pnpm --filter @everdict/cli bundle`.

Verified: the 1 MB bundle contains **0** temporal/native references and executes the full runner path
(capability probe → MCP connect → lease loop) as one file.

## Slices

- **S1 — standalone bundle (DONE).** Runner-only entry + esbuild bundle; temporal-free, runs end to end.
- **S2 — SEA binaries + release CI.** Node SEA (`postject` into the platform node) on a 3-OS matrix, tag `cli-v*` → GitHub Release assets (`everdict-runner-{linux,macos,windows}-{x64,arm64}`). Mirrors `.github/workflows/desktop-release.yml`.
- **S3 — `GET /install.sh`.** Control-plane route rendering the OS/arch-detecting installer (download the matching asset → install to a PATH dir → pair). Token embedded (same one-time secret as the printed command). BFF↔MCP parity not required (a plain script route).
- **S4 — web one-liner.** The "Register shared runner" registered step shows the served `curl … | sh` one-liner alongside the raw attach command.

## Non-goals

- Auto-update of the standalone binary (the desktop runner already self-updates, D13; a headless binary is re-installed by its operator — the roster's `updateRequired` badge tells them).
- Signing/notarization (deferred until a certificate exists, same as the desktop release).
