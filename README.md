# Assay

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
| `@assay/core` | contracts (interfaces + Zod + errors). Dependency root. |
| `@assay/drivers` | in-sandbox compute (`LocalDriver`, `DockerDriver` for image-pinned cases). |
| `@assay/environments` | the world a run acts on (`RepoEnvironment`). |
| `@assay/harnesses` | the agent under test: `ClaudeCodeHarness`, `ScriptedHarness`, declarative `CommandHarness` (any CLI, no code — `docs/command-harness.md`). |
| `@assay/graders` | scoring (tests-pass / cost / steps / latency) + **Agent Judge** (`JudgeGrader`: LLM/VLM/agent verdict — `docs/judges.md`). |
| `@assay/runner` | the eval loop (`runCase`). |
| `@assay/agent` | the dispatched unit (model B): runs `runCase` in an isolated job. |
| `@assay/backends` | placement: `Backend` (Local/Nomad/K8s) + `Router`/`Scheduler` (tenant-fair WFQ, quotas, budgets) + trust zones + autoscaler + tenant `RuntimeSpec`→live backend (`docs/runtimes.md`). |
| `@assay/orchestrator` | durable control plane on Temporal (Direct / Temporal + worker; powers scheduled evals). |
| `@assay/trace` | pull a harness trace from OTel/MLflow → `TraceEvent`; usage-proxy metering. |
| `@assay/topology` | service-topology harnesses (multi-service + target env), Nomad/K8s/Docker runtimes. |
| `@assay/suite` | suites + version regression: `runSuite`, scorecard summary/diff, **leaderboard** (`docs/suites.md`, `docs/scorecards.md`). |
| `@assay/db` | result stores: `RunStore` + `ScorecardStore` (in-memory / Postgres) + SQL migrations. |
| `@assay/registry` | versioned SSOT for **harnesses · datasets · judges · runtimes**: `(tenant, id, version)`, immutable versions, `_shared` fallback (`docs/registry.md`). |
| `@assay/auth` | control-plane auth core: OIDC (Keycloak) + API keys → `Principal{workspace,roles}` + role authZ. |
| `@assay/runner-core` | **self-hosted runner core** shared by CLI + desktop: MCP lease loop, resilient session, kind-branch execution, `RunnerHost` facade. |
| `apps/cli` | dev control plane: `assay run` / `worker` / `suite` / **`assay runner`** (self-hosted, headless). |
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
git clone https://github.com/Ho2eny/assay && cd assay
docker compose -f deploy/compose/docker-compose.dev.yaml up --build
# web http://localhost:3001 · API http://localhost:8787 — auth off, single tenant, in-memory stores
```
Hardened profile (Postgres persistence, secrets-at-rest, healthchecks): `deploy/compose/README.md`.
Human SSO (Keycloak OIDC): `deploy/keycloak/` (realm auto-import) + `docs/dev.md`.

## Run (CLI quickstart)
```bash
pnpm install && pnpm build
# local — uses THIS machine's claude subscription (no API key):
pnpm assay run --task "Create ok.txt with the text done" --test "grep -q done ok.txt"
# distributed (Nomad/K8s) and/or durable (Temporal): see docs/execution-backends.md + docs/orchestration.md
# control plane + web: node apps/api/dist/main.js (+ docs/dev.md for Keycloak + web hot-reload)
```

## Desktop app (`apps/desktop`)
웹과 **동일한 기능**(배포된 웹을 그대로 렌더링) + 이 기기를 셀프호스티드 러너로 쓰는 상주 앱.
계정 페이지에서 **"이 기기를 러너로 연결" 버튼 한 번**으로 페어링됩니다(토큰 복사 없음 — OS
키체인에 저장). 트레이 상주(닫기=숨김), 잡 완료 알림, 자동 시작 토글.

```bash
# 설치파일 다운로드: 웹의 /{workspace}/download — OS 자동 감지 + 로그인 뒤 302 프록시(리포 private 유지).
#   (서버 env: DESKTOP_RELEASES_TOKEN=fine-grained PAT[contents:read]; GitHub 직접 접근은 콜라보레이터만
#    가능 — https://github.com/Ho2eny/assay/releases/latest)
# (unsigned — mac Gatekeeper/win SmartScreen 경고는 우회 실행. 서명은 인증서 확보 후)

# dev 실행 (웹 :3000 + 컨트롤플레인 :8787 이 떠 있어야 함):
ASSAY_WEB_URL=http://localhost:3000 pnpm -F @assay/desktop dev

# 로컬 패키징 (이 OS 타깃, turbo 게이트 밖):
pnpm -F @assay/desktop package        # → apps/desktop/release/

# 3-OS 릴리즈 (CI): 태그 하나로 GitHub Release 발행
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

- 라이브 e2e: `node scripts/live/desktop-runner.mjs` (원클릭 페어 → `self:<id>` 런 → provenance 검증).
- **자동 업데이트**: 클라이언트는 내장·검증 완료(감지/다운로드 자동, 적용은 트레이에서 재시작).
  피드 공개 위치가 결정되면(`electron-builder.yml` publish 블록) 활성화됩니다 — 현재는 비활성.
- 웹 다운로드 페이지(`/{ws}/download`) 활성화: `DESKTOP_RELEASES_TOKEN` 설정(미설정 시 `DESKTOP_DOWNLOAD_URL` 외부 링크 폴백).

## Self-hosted runner (내 머신에서 실행)
워크스페이스의 공유 하니스·데이터셋을 **런타임만 `self:<id>` 로 바꿔** 내 호스트에서 실행하고 결과를
회신합니다(내 로그인이 비용 부담 — 워크스페이스 예산 미차감, provenance 태그 부착).
**개인 머신 = 데스크톱 앱 원클릭이 유일한 페어링 표면**(웹 브라우저는 목록/해제만 — D7).
headless 서버/CI 박스는 API 키로 페어링 토큰을 만들어 CLI 로:
```bash
curl -X POST <control-plane>/runners -H "Authorization: Bearer ak_…" \
  -H "content-type: application/json" -d '{"label":"ci-linux-01"}'   # → { runner, token: "rnr_…" }
assay runner --pair <rnr_…> --api-url <control-plane> [--max-concurrent N]
```
See `docs/architecture/self-hosted-runner.md` (+ service harnesses on your Docker:
`self-hosted-service-runner.md`).

## Connect an agent (MCP)
The agent-facing surface is an OAuth-protected MCP server at `POST /mcp` — same tools as the HTTP API,
role-gated + workspace-scoped. Connect with **OAuth browser login (like Linear)** or a headless **API key**.
Endpoint: `http://<host>:8787/mcp` (set `<host>` to where `apps/api` runs).

### Claude Code
```bash
# OAuth — "login like Linear": opens the browser, log in via Keycloak, done.
claude mcp add --transport http assay http://<host>:8787/mcp

# headless with an API key (CI / no browser):
claude mcp add --transport http assay http://<host>:8787/mcp \
  --header "Authorization: Bearer ak_..."
```

### Codex
Codex reaches a remote MCP via `mcp-remote` (runs the OAuth + PKCE flow). Add to `~/.codex/config.toml`:
```toml
[mcp_servers.assay]
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
(**계정 → API 키**) or `POST /keys`. Both credentials resolve to the same `Principal{workspace, roles}`.
See `docs/mcp.md`.

### When the browser doesn't open
"A browser window will open for authentication" means discovery + client registration already succeeded
(server side is fine) — only the local browser launch failed. Fixes:
```bash
claude mcp remove assay 2>/dev/null    # clear a half-finished add
rm -rf ~/.mcp-auth                      # clear stale mcp-remote OAuth cache

# A) open the printed URL yourself, or force the browser:
BROWSER=google-chrome claude mcp add --transport http assay http://<host>:8787/mcp

# B) mcp-remote prints the auth URL explicitly (same client Codex uses):
claude mcp add assay -- npx -y mcp-remote http://<host>:8787/mcp

# C) skip the browser entirely with an API key:
claude mcp add --transport http assay http://<host>:8787/mcp \
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
[GitHub Releases](https://github.com/Ho2eny/assay/releases), auto-update client) — all with
control-plane-owned auth (real Keycloak OIDC + API keys), Postgres persistence, the web as a BFF token
courier, and the agent-facing MCP server (full BFF↔MCP parity). Shipped but awaiting a live external
e2e: GitHub Actions CI triggers (PR pins / merge re-pin, OIDC federation). Still needing your
infra/images: real browser+extension images, ClickHouse analytics, code-signing certs (desktop).

## License
[Apache-2.0](LICENSE).
