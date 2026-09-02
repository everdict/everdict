---
kind: runbook
title: "Runbook — deploying behind a corporate proxy"
status: current
updated: 2026-07-28
---
# Runbook — deploying behind a corporate proxy

For everdict deployments inside a corporate network where internet egress goes through an HTTP(S)
proxy (often TLS-intercepting), or is blocked entirely (air-gap). Symptom this runbook exists for:
a page/feature that needs an external service (desktop installer list, LLM providers, trace pull
from a SaaS observability platform, GitHub App) silently shows an empty/fallback state while
everything in-network works.

## The one mental model

Server-side outbound HTTP in everdict is Node's built-in `fetch` (undici). **Node ignores
`HTTP_PROXY`/`HTTPS_PROXY` env by default** — so each everdict process installs a proxy-aware
global dispatcher at boot (`EnvHttpProxyAgent`) that makes the standard env trio work:

| Env | Meaning |
| --- | --- |
| `HTTP_PROXY` / `HTTPS_PROXY` | proxy URL for outbound http/https (lowercase forms honored too) |
| `NO_PROXY` | comma-separated hosts that bypass the proxy (internal targets) |
| `CA_CERT` | the TLS-intercepting proxy's root CA (PEM, compose-only — see below) |

Processes that honor the trio at runtime, and what each needs it for:

| Process | External calls behind the proxy |
| --- | --- |
| `apps/api` (control plane) | LLM providers (model judges), trace pull/export, GitHub App, Mattermost |
| `apps/agent` | LLM providers, web search, GitHub/Mattermost integration actions |
| Temporal worker (`everdict worker`) | trace pull from tenant observability platforms, tenant-registered cluster APIs |
| `apps/web` | the desktop-releases GitHub fetch (installer list) |

Each logs one boot line when active: `[everdict…] outbound proxy: … (NO_PROXY honored)` — its
absence means the env didn't reach the process.

## Compose stacks (deploy/compose)

The three stacks pass the trio at **build** time (`x-build-args`, for apt/corepack inside image
builds) and at **runtime** (`x-runtime-proxy-env`, merged into the services above). Two things are
automatic:

- **Internal names never touch the proxy**: compose service names (`api`, `agent`, `postgres`,
  `temporal`, …) are appended to `NO_PROXY` unconditionally, so web→api or api→agent traffic can't
  be misrouted through the corporate proxy even if you forget to list them.
- **The corp CA works at runtime too**: when `CA_CERT` is set in the deploy env at `up` time,
  `NODE_EXTRA_CA_CERTS` points Node at the CA the Dockerfiles baked in the image base stage.

So the whole setup is: put `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`CA_CERT` in the compose `.env`,
`docker compose … up --build`. Nothing else.

## Desktop app

- **Auto-update** rides Electron's Chromium network stack (`electron-updater` →
  `net.request`), which follows the **OS proxy settings** — not the env trio. A machine whose
  browser works will update fine. For an internal mirror, set `EVERDICT_UPDATE_FEED_URL` to a
  generic feed URL.
- **Installer download page** (`/connect/desktop`) is served by `apps/web` (see the table above).
  Knobs, in escalation order:
  - proxy env on the web service → the default `api.github.com` fetch works through the proxy;
  - `DESKTOP_RELEASES_TOKEN` (fine-grained PAT, `contents:read`) → lifts the 60 req/h
    unauthenticated rate limit, which a whole company NATed behind one egress IP exhausts quickly;
  - `DESKTOP_RELEASES_API_URL` + `DESKTOP_RELEASES_REPO` → point at a GitHub Enterprise mirror of
    the releases repo (`https://<ghe-host>/api/v3`) when github.com is unreachable even via proxy;
  - `DESKTOP_DOWNLOAD_URL` → last-resort external link shown when the list can't be fetched at all.

## Self-hosted runners

Runners are assumed to reach the control plane **directly** (it lives on the same corporate
network). A runner dialing an off-network control plane through the proxy is not supported yet.

## Verifying / diagnosing

From inside the container that misbehaves:

```bash
node -e "fetch('https://api.github.com/').then(r=>console.log('status',r.status)).catch(e=>console.error(e.cause??e))"
```

| Signature | Cause |
| --- | --- |
| `ETIMEDOUT` / `ECONNREFUSED` | egress goes direct and is blocked — proxy env missing (check the boot log line) |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` | TLS-intercepting proxy, CA not trusted — set `CA_CERT` (compose wires `NODE_EXTRA_CA_CERTS`) |
| `status 403` on api.github.com | unauthenticated rate limit on the shared egress IP — set `DESKTOP_RELEASES_TOKEN` |
| internal call (web→api) hangs/fails only with proxy set | internal host routed through the proxy — add it to `NO_PROXY` (compose appends service names automatically) |
