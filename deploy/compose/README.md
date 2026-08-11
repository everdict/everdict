# Docker Compose — web + API full stack

Brings up `apps/web` (Next.js, `:3001`) and `apps/api` (the Fastify control plane, `:8787`) at once. dev/prod are separate.

Image definitions: `apps/api/Dockerfile`, `apps/web/Dockerfile` (both multi-stage — `dev` / `runtime` targets).
Every build context is the **repo root** (`../..`) — since this is a pnpm monorepo, the whole workspace is needed.

Behind a corporate proxy (egress via HTTP proxy / TLS-intercepting CA / air-gap): set the standard
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`CA_CERT` in the compose env — the stacks pass them through at build
AND runtime. Full guide: `docs/runbooks/corporate-proxy.md`.

## dev — fast full-stack startup (hot reload, auth OFF)

```bash
docker compose -f deploy/compose/docker-compose.dev.yaml up --build
```

- web http://localhost:3001 · API http://localhost:8787
- No auth: the web runs in dev mode, the API uses the dev fallback (`x-everdict-tenant`) → clickable right away. Tenant is `default`.
- Stores are **in-memory** → reset on restart. Backend is **local** (in-process on this machine).
- Source is bind-mounted into the containers (Linux host → node_modules compatible): web=`next dev`, API=`tsc -w`+`node --watch`.
- To actually run the `claude-code` harness, set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the shell/`.env`.
  (the `scripted` harness works without a token — suitable for smoke tests)

Sanity check:
```bash
curl localhost:8787/healthz
curl -XPOST localhost:8787/runs -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "harness":{"id":"scripted","version":"latest"},
  "case":{"id":"c1","env":{"kind":"repo","source":{"files":{}}},"task":"...","graders":[{"id":"steps"}],"timeoutSec":120,"tags":[]}}'
```

> For native hot reload without containers (Keycloak+API in Docker, web on the host), there is also `bash scripts/dev/up.sh`.

## prod — hardened full stack (Postgres, no Keycloak)

```bash
cp deploy/compose/.env.example deploy/compose/.env   # at minimum POSTGRES_PASSWORD
docker compose -f deploy/compose/docker-compose.prod.yaml --env-file deploy/compose/.env up -d --build
```

Differences:
- **Postgres** (persistent volume, migrations applied automatically at startup).
- Secret at-rest encryption (`EVERDICT_SECRETS_KEY`) + an internal token (`EVERDICT_INTERNAL_TOKEN`) + per-tenant run budgets (optional).
- `restart: unless-stopped` + health checks + `depends_on(healthy)`. No bind mounts (runs the built runtime artifacts).

### ⚠️ Auth (Keycloak removed)
The web has no static API-key path, so without Keycloak it operates as `x-everdict-tenant=default`. The API therefore does not
enforce auth either (`EVERDICT_REQUIRE_AUTH` unset) — that is, **a single tenant `default`, auth not enforced**. This stack assumes
it sits **on a trusted network / behind a reverse proxy** (do not expose it directly to the public internet).

If you need real auth:
- **Programmatic/MCP access only** → set `EVERDICT_REQUIRE_AUTH=1` + `EVERDICT_INTERNAL_TOKEN` in the API env and mint API keys
  (`ak_…`) from `/internal/tenant-keys`. Note that in this case the web UI has no means of authentication and will not work.
- **Human SSO** → put a reverse proxy such as oauth2-proxy in front, or add Keycloak back (see `deploy/keycloak/`).

## full — the self-hosted flagship (nothing in-memory: Postgres + Temporal + MinIO)

```bash
bash deploy/compose/full.sh                  # creates .env + generates every required secret, then up -d --build
bash deploy/compose/full.sh --profile auth   # extra compose args pass through (Keycloak auth, browser sidecars)
```

Everything the prod stack has, plus: **Temporal** (durable batches + schedules) and **MinIO** — the object
storage behind the **workspace filesystem** (one bucket per tenant, `everdict-fs-<tenant>-<hash8>`, created
lazily; skill/knowledge bodies + agent task outputs + the web `/files` tree live there) and artifact offload
(`everdict-artifacts`, presigned URLs). Buckets persist on the `minio-data` volume; the MinIO console
(`:9101`) lets an operator inspect a tenant's bucket. Secrets live in `deploy/compose/.env` (gitignored) —
`full.sh` fills any missing/`change-me-*` value and never overwrites a real one. Manual alternative:
`cp .env.full.example .env`, set the four required secrets, then
`docker compose -f deploy/compose/docker-compose.full.yaml --env-file deploy/compose/.env up -d --build`.

**Trace ledger.** Everdict keeps its own copy of every trace it stands on — eval runs, agent conversation
turns, arrivals at the OTLP door (`POST /v1/traces`), materialized pull-imports — and Settings › Traces reads
that ledger. By default it lives in Postgres, which is enough at eval-scale. For ops-scale volume, move *only*
that store to the bundled ClickHouse (everything else stays on Postgres):

```bash
# in deploy/compose/.env
EVERDICT_CLICKHOUSE_URL=http://clickhouse:8123
bash deploy/compose/full.sh --profile clickhouse    # or: docker compose … --profile clickhouse up -d
```

The table is created at boot — no migration step. ⚠️ The swap is **not** a migration either: trajectories
already sealed in Postgres stay there and vanish from the ledger until you switch back. ⚠️ The URL and the
profile travel together — a URL set with the profile off boots the api against an engine that isn't running
and it restarts forever (clear the URL to return to Postgres). Two related knobs live next to it in `.env`:
`EVERDICT_INGEST_MAX_EVENTS_PER_HOUR` (the door's per-workspace hourly quota; past it the door answers 429
instead of dropping silently) and `EVERDICT_TRAJECTORY_RETENTION_DAYS`.

## Build just the images

```bash
docker build -f apps/api/Dockerfile --target runtime -t everdict-api .   # from the repo root
docker build -f apps/web/Dockerfile --target runtime -t everdict-web .
```

> Note: the runtime image copies all of `/app` (including node_modules) for reliability first. Slimming the image can be a
> follow-up optimization via `pnpm deploy --filter <pkg> --prod` or Next standalone (`output: 'standalone'`).

## Versions — each service releases on its own tag

The four server images are built from one commit but versioned separately: a git tag names one service and
one version, and `.github/workflows/images.yml` publishes only that image.

| tag | publishes |
|---|---|
| `api-v1.2.0` | `ghcr.io/everdict/everdict-api:1.2.0` + `:latest` |
| `web-v1.2.0` | `ghcr.io/everdict/everdict-web:1.2.0` + `:latest` |
| `agent-v1.2.0` | `ghcr.io/everdict/everdict-agent:1.2.0` + `:latest` |
| `job-runner-v1.2.0` | `ghcr.io/everdict/everdict-job-runner:1.2.0` + `:latest` |
| `v1.2.0` | all four at `1.2.0` — the stack tag, for when they genuinely move together |

Every tag also gets a GitHub Release (generated notes), and the release job runs only after each image of that
ref has pushed — so the page never advertises a build that failed. `cli-v*` and `desktop-v*` are unchanged;
they have their own workflows.

Pin them independently in `.env`:

```dotenv
EVERDICT_VERSION=1.2.0        # what any unset service falls back to
EVERDICT_API_VERSION=1.3.1    # …and this one moves on its own
```

⚠️ **A version no longer proves a working set.** These four share `packages/contracts` and the web is a typed
client of that wire, so "api 1.3.1 with web 1.2.0" is a claim you are making, not one the version numbers
check. When they move together, use the stack tag and let every service inherit `EVERDICT_VERSION`.

⚠️ **`:latest` belongs to whichever tag was pushed last.** Releasing `api-v1.3.0` and then `v1.2.0` moves
`everdict-api:latest` backwards. Pick one axis per service and stay on it.
