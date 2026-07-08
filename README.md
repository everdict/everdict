# Everdict

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Harness-agnostic, infra-agnostic **agent evaluation runtime**. Register & version any agent harness —
a CLI (Claude Code, Codex, or any binary via the declarative `command` harness) or a multi-service
topology (browser-use LangGraph) — run it across environments (repo / browser / os-use) and runtimes
(Nomad / K8s / Docker / your own laptop), and **score** it fairly, repeatably, with regression
tracking, leaderboards and scheduled re-runs. Eval-first; just enough operational runtime to drive
long, stateful, isolated runs. **Fully self-hosted** — no vendor sandbox; isolation comes from your own
Nomad/K8s (gVisor/Kata). Humans use the **web** or the **desktop app**; agents/CI use **MCP / API keys**.

## The spine
A run separates four in-sandbox concerns + a placement layer:
**Harness** (under test) · **Environment** (the world it acts on) · **Driver** (in-sandbox compute) ·
**Grader** (how we judge — incl. LLM/VLM/agent **judges**) · **Backend** (where it's placed).

## Architecture (one-way deps)
```
core ← { drivers · environments · harnesses · graders · trace } ← runner ← agent ← backends ← { orchestrator · topology · suite } ← runner-core ← { apps/cli · apps/desktop }
control plane on top: apps/api (HTTP+MCP) · apps/web (SaaS web) — see CLAUDE.md for the full map
```

## Packages
| Package | Role |
|---|---|
| `@everdict/core` | contracts (interfaces + Zod + errors). Dependency root. |
| `@everdict/drivers` | in-sandbox compute (`LocalDriver`, `DockerDriver` for image-pinned cases). |
| `@everdict/environments` | the world a run acts on (`RepoEnvironment`). |
| `@everdict/harnesses` | the agent under test: `ClaudeCodeHarness`, `ScriptedHarness`, declarative `CommandHarness` (any CLI, no code — `docs/command-harness.md`). |
| `@everdict/graders` | scoring (tests-pass / cost / steps / latency) + **Agent Judge** (`JudgeGrader`: LLM/VLM/agent verdict — `docs/judges.md`). |
| `@everdict/runner` | the eval loop (`runCase`). |
| `@everdict/agent` | the dispatched unit (model B): runs `runCase` in an isolated job. |
| `@everdict/backends` | placement: `Backend` (Local/Nomad/K8s) + `Router`/`Scheduler` (tenant-fair WFQ, quotas, budgets) + trust zones + autoscaler + tenant `RuntimeSpec`→live backend (`docs/runtimes.md`). |
| `@everdict/orchestrator` | durable control plane on Temporal (Direct / Temporal + worker; powers scheduled evals). |
| `@everdict/trace` | pull a harness trace from OTel/MLflow → `TraceEvent`; usage-proxy metering. |
| `@everdict/topology` | service-topology harnesses (multi-service + target env), Nomad/K8s/Docker runtimes. |
| `@everdict/suite` | suites + version regression: `runSuite`, scorecard summary/diff, **leaderboard** (`docs/suites.md`, `docs/scorecards.md`). |
| `@everdict/db` | result stores: `RunStore` + `ScorecardStore` (in-memory / Postgres) + SQL migrations. |
| `@everdict/registry` | versioned SSOT for **harnesses · datasets · judges · runtimes**: `(tenant, id, version)`, immutable versions, `_shared` fallback (`docs/registry.md`). |
| `@everdict/auth` | control-plane auth core: OIDC (Keycloak) + API keys → `Principal{workspace,roles}` + role authZ. |
| `@everdict/runner-core` | **self-hosted runner core** shared by CLI + desktop: MCP lease loop, resilient session, kind-branch execution, `RunnerHost` facade. |
| `apps/cli` | dev control plane: `everdict run` / `worker` / `suite` / **`everdict runner`** (self-hosted, headless). |
| `apps/api` | multi-tenant control-plane HTTP API (Fastify) + agent-facing **MCP server** (`/mcp`): runs, scorecards (+diff/ingest/leaderboard), datasets, judges, runtimes, schedules, bundles, connections, runners, CI triggers — full BFF↔MCP parity (`docs/api.md`, `docs/mcp.md`). |
| `apps/web` | SaaS web (Next.js FSD, Linear-style): Keycloak login, per-workspace dashboard (runs/harnesses/datasets/scorecards/leaderboard/judges/runtimes/schedules/bundles), workspace settings, personal account (connected accounts · runners · API keys) (`docs/web.md`). |
| `apps/desktop` | **Electron desktop**: renders the deployed web (full parity by construction) + resident self-hosted runner with one-click pairing + auto-update client (`docs/architecture/desktop-app.md`). |

## Two kinds of harness
- **Process harness** (Claude Code, Codex, any CLI via `command`): one binary run in a sandbox.
- **Service-topology harness** (browser-use-langgraph): a deployed topology (agent / MCP / action-stream
  + Postgres/Redis/MinIO) that acts on a target env (browser + extension). Efficient: warm per-version
  services + shared ID-keyed stores + per-case browser. See `docs/service-harness.md`.

## Run (Docker Compose quickstart)
```bash
git clone https://github.com/everdict/everdict && cd everdict

# Dev: hot-reload, auth off, in-memory stores (builds from source)
docker compose -f deploy/compose/docker-compose.dev.yaml up --build
# web http://localhost:3001 · API http://localhost:8787

# Or the hardened profile with prebuilt images from GHCR (Postgres persistence, no local build):
cp deploy/compose/.env.example deploy/compose/.env   # set POSTGRES_PASSWORD
docker compose -f deploy/compose/docker-compose.prod.yaml --env-file deploy/compose/.env up -d
# (add --build to build from source instead of pulling ghcr.io/everdict/everdict-{api,web})
```
Details: `deploy/compose/README.md`. Human SSO (Keycloak OIDC): `deploy/keycloak/` (realm auto-import) + `docs/dev.md`.

## Run (CLI quickstart)
```bash
pnpm install && pnpm build
# local — uses THIS machine's claude subscription (no API key):
pnpm everdict run --task "Create ok.txt with the text done" --test "grep -q done ok.txt"
# distributed (Nomad/K8s) and/or durable (Temporal): see docs/execution-backends.md + docs/orchestration.md
# control plane + web: node apps/api/dist/main.js (+ docs/dev.md for Keycloak + web hot-reload)
```

## Desktop app (`apps/desktop`)
**Full parity with the web** (renders the deployed web as-is) + a resident app that turns this machine into a self-hosted runner.
Pair from the account page with **a single "Connect this device as a runner" button** (no token copy — stored in the OS
keychain). Tray-resident (close = hide), job-completion notifications, auto-start toggle.

```bash
# Download the installer straight from GitHub Releases (the repo is public):
#   https://github.com/everdict/everdict/releases/latest
#   (Linux AppImage/deb · macOS dmg/zip [x64+arm64] · Windows exe)
# Or the web's /{workspace}/download page (auto OS detection).
# (unsigned — bypass the mac Gatekeeper / win SmartScreen warning to run. Signing once a certificate is obtained.)

# dev run (the web :3000 + control plane :8787 must be up):
EVERDICT_WEB_URL=http://localhost:3000 pnpm -F @everdict/desktop dev

# local packaging (this OS target, outside the turbo gate):
pnpm -F @everdict/desktop package        # → apps/desktop/release/

# 3-OS release (CI): a single tag publishes a GitHub Release
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

- Live e2e: `node scripts/live/desktop-runner.mjs` (one-click pair → `self:<id>` run → provenance check).
- **Auto-update**: enabled — the client checks GitHub Releases (`everdict/everdict`) on launch + every 6h, downloads
  in the background, and applies on a user-consented tray restart. Ship an update by pushing a `desktop-v*` tag.
- Enabling the web download page (`/{ws}/download`): set `DESKTOP_RELEASES_TOKEN` (unset ⇒ falls back to the `DESKTOP_DOWNLOAD_URL` external link).

## Self-hosted runner (run on your own machine)
Run a workspace's shared harnesses/datasets on your own host by **changing only the runtime to `self:<id>`**, and report the
results back (your own login pays the cost — the workspace budget is untouched, a provenance tag is attached).
**Personal machine = the desktop app's one-click is the only pairing surface** (the web browser only lists/revokes — D7).
Headless servers / CI boxes mint a pairing token with an API key and use the CLI:
```bash
curl -X POST <control-plane>/runners -H "Authorization: Bearer ak_…" \
  -H "content-type: application/json" -d '{"label":"ci-linux-01"}'   # → { runner, token: "rnr_…" }
everdict runner --pair <rnr_…> --api-url <control-plane> [--max-concurrent N]
```
See `docs/architecture/self-hosted-runner.md` (+ service harnesses on your Docker:
`self-hosted-service-runner.md`).

## Connect an agent (MCP)
The agent-facing surface is an OAuth-protected MCP server at `POST /mcp` — same tools as the HTTP API,
role-gated + workspace-scoped. Connect with **OAuth browser login (like Linear)** or a headless **API key**.
Endpoint: `http://<host>:8787/mcp` (set `<host>` to where `apps/api` runs).

### Claude Code plugin (recommended)
This repo doubles as a Claude Code **plugin marketplace**. The `everdict` plugin bundles the MCP
server **and** the Everdict domain context — an `everdict` skill (the domain model + eval workflows)
plus `/everdict:setup` and `/everdict:eval` commands — so any session can drive an eval end-to-end
with no prior Everdict context.

```bash
# 1) Tell the bundled MCP server where your control plane is. Put this in your shell profile so it's
#    set whenever Claude Code launches (the bundled server reads ${EVERDICT_MCP_URL} at startup):
export EVERDICT_MCP_URL=http://<host>:8787/mcp

# 2) Inside Claude Code, add this repo as a marketplace and install the plugin:
/plugin marketplace add everdict/everdict
/plugin install everdict@everdict
#    then restart Claude Code so the bundled `everdict` MCP server picks up EVERDICT_MCP_URL.
```

Auth is the same "login like Linear": the first tool call opens a **browser OAuth login** (Keycloak).
Headless / CI uses an API key instead of the browser:
```bash
claude mcp add --transport http everdict "$EVERDICT_MCP_URL" \
  --header "Authorization: Bearer ak_..."
```

Verify with `/mcp` (the `everdict` server is listed) and `/help` (the `everdict` skill + `/everdict:*`
commands appear); then `/everdict:setup` to confirm the connection, or `/everdict:eval` to evaluate
the current project's agent. Details: [`plugin/README.md`](plugin/README.md).

### Claude Code (manual MCP server)
Prefer to wire the MCP server yourself (no plugin)? Add it directly:
```bash
# OAuth — "login like Linear": opens the browser, log in via Keycloak, done.
claude mcp add --transport http everdict http://<host>:8787/mcp

# headless with an API key (CI / no browser):
claude mcp add --transport http everdict http://<host>:8787/mcp \
  --header "Authorization: Bearer ak_..."
```

### Codex
Codex reaches a remote MCP via `mcp-remote` (runs the OAuth + PKCE flow). Add to `~/.codex/config.toml`:
```toml
[mcp_servers.everdict]
command = "npx"
args = ["-y", "mcp-remote", "http://<host>:8787/mcp"]
# headless instead — drop the browser, use an API key:
# args = ["-y", "mcp-remote", "http://<host>:8787/mcp", "--header", "Authorization: Bearer ak_..."]
```

On first OAuth connect you log in to Keycloak and **approve a one-time consent** ("allow"), then the
loopback callback completes automatically — the whole DCR → PKCE auth-code → consent → token → `/mcp` flow is
verified end-to-end by `scripts/live/mcp-oauth.mjs`.

OAuth needs anonymous Dynamic Client Registration enabled once on Keycloak
(`deploy/keycloak/enable-mcp-dcr.sh` — loopback redirect URIs only). Get an API key from the web
(**Account → API keys**) or `POST /keys`. Both credentials resolve to the same `Principal{workspace, roles}`.
See `docs/mcp.md`.

### When the browser doesn't open
"A browser window will open for authentication" means discovery + client registration already succeeded
(server side is fine) — only the local browser launch failed. Fixes:
```bash
claude mcp remove everdict 2>/dev/null    # clear a half-finished add
rm -rf ~/.mcp-auth                      # clear stale mcp-remote OAuth cache

# A) open the printed URL yourself, or force the browser:
BROWSER=google-chrome claude mcp add --transport http everdict http://<host>:8787/mcp

# B) mcp-remote prints the auth URL explicitly (same client Codex uses):
claude mcp add everdict -- npx -y mcp-remote http://<host>:8787/mcp

# C) skip the browser entirely with an API key:
claude mcp add --transport http everdict http://<host>:8787/mcp \
  --header "Authorization: Bearer ak_..."
```
A remote/SSH shell can't open a browser **and** receive the loopback callback — use the API key (C) there.

## Develop
```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
`apps/web` is self-contained (eslint+prettier, excluded from root Biome); everything else — including
`apps/desktop` — uses the root Biome. Conventions live in `CLAUDE.md` + `.claude/` (read first).

## Docs
- `docs/README.md` — the full doc index
- `docs/architecture/overview.md` — the architecture map · `docs/architecture/` — design SSOTs per effort
  (desktop-app, self-hosted-runner, scheduled-evals, github-actions-trigger, bundles, leaderboard, …)
- `docs/api.md` + `docs/mcp.md` — control-plane HTTP + MCP surfaces (BFF↔MCP parity)
- `docs/datasets.md` · `docs/judges.md` · `docs/runtimes.md` · `docs/scorecards.md` — the eval entities
- `docs/web.md` — the SaaS web · `docs/connections.md` — personal connected accounts (outbound OAuth)
- `docs/service-harness.md` — multi-service topologies · `docs/execution-backends.md` — Backend vs Driver
- `docs/orchestration.md` — Temporal · `docs/auth.md` — auth core · `docs/tenancy.md` — workspaces
- `docs/dev.md` — local dev loop · `docs/migration/` — DB migration discipline

## Status
Validated **live** (each with a `scripts/live/*.mjs` proof): local + real Claude Code (subscription);
durable Temporal end-to-end + **scheduled evals** (cron scorecards, real Temporal Schedules); Nomad batch
dispatch; service-topology on **both Nomad and Kubernetes (kind)**; the SaaS operational layer on real
Nomad (tenant-fair scheduler, trust zones, autoscaling, budgets); the full control plane — runs,
**batch scorecards + diff + push/pull trace ingest (real MLflow 3.x) + harness×model leaderboard**,
harness-agnostic **datasets**, user-registered **judges** (model judge live vs LiteLLM) and **runtimes**
(k8s kubeconfig auth), **bundles** (one-shot install: codex+PinchBench, SpreadsheetBench), workspace
invites + per-key API scopes, personal **connected accounts** (GitHub one-click, Mattermost notify),
**self-hosted runner** (pair → `self:<id>` runs with provenance, cross-workspace, service harnesses on
local Docker) and the **desktop app** (web-parity Electron shell, one-click pairing, 3-OS release CI →
[GitHub Releases](https://github.com/everdict/everdict/releases), auto-update client) — all with
control-plane-owned auth (real Keycloak OIDC + API keys), Postgres persistence, the web as a BFF token
courier, and the agent-facing MCP server (full BFF↔MCP parity). Shipped but awaiting a live external
e2e: GitHub Actions CI triggers (PR pins / merge re-pin, OIDC federation). Still needing your
infra/images: real browser+extension images, ClickHouse analytics, code-signing certs (desktop).

## License
[Apache-2.0](LICENSE).
