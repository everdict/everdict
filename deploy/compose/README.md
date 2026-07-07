# Docker Compose — web + API full stack

Brings up `apps/web` (Next.js, `:3001`) and `apps/api` (the Fastify control plane, `:8787`) at once. dev/prod are separate.

Image definitions: `apps/api/Dockerfile`, `apps/web/Dockerfile` (both multi-stage — `dev` / `runtime` targets).
Every build context is the **repo root** (`../..`) — since this is a pnpm monorepo, the whole workspace is needed.

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

## Build just the images

```bash
docker build -f apps/api/Dockerfile --target runtime -t everdict-api .   # from the repo root
docker build -f apps/web/Dockerfile --target runtime -t everdict-web .
```

> Note: the runtime image copies all of `/app` (including node_modules) for reliability first. Slimming the image can be a
> follow-up optimization via `pnpm deploy --filter <pkg> --prod` or Next standalone (`output: 'standalone'`).
