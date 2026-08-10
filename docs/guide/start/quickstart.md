# Quickstart

Everdict self-hosts as a Docker Compose stack. There are three profiles; start with `dev`, which needs
nothing but Docker and comes up clickable.

## dev — the whole stack, no auth, in-memory

```bash
git clone https://github.com/everdict/everdict && cd everdict
docker compose -f deploy/compose/docker-compose.dev.yaml up --build
```

- web → <http://localhost:3001> · API → <http://localhost:8787>
- **No auth.** The web runs in dev mode and the API falls back to the `x-everdict-tenant` header, so you
  land in a usable workspace immediately. The tenant is `default`.
- **Stores are in-memory** — everything resets when the stack restarts. That is the point of this
  profile; use `prod` or `full` the moment you want to keep a result.
- Placement is the **local** backend (in-process on this machine).
- Source is bind-mounted, so the web hot-reloads and the API rebuilds on change.

Check it is alive:

```bash
curl localhost:8787/healthz
```

Submit a run without any agent credentials — the `scripted` harness replays a canned trace, which is
exactly what you want for a smoke test:

```bash
curl -XPOST localhost:8787/runs \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "harness": { "id": "scripted", "version": "latest" },
  "case": {
    "id": "c1",
    "env": { "kind": "repo", "source": { "files": {} } },
    "task": "...",
    "graders": [{ "id": "steps" }],
    "timeoutSec": 120,
    "tags": []
  }}'
```

The response is a `runId` — submission is asynchronous. Poll `GET /runs/{id}`, or watch it in the web
app.

To drive a **real** agent, give the stack a credential: set `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` in your shell or a `.env` before `up`, then use the `claude-code` harness
instead of `scripted`.

## One eval from the CLI, no containers

If you have the repo built and a local Claude subscription, you can skip the stack entirely:

```bash
pnpm install && pnpm build
pnpm everdict run --task "Create ok.txt with the text done" --test "grep -q done ok.txt"
```

This uses the machine's existing login rather than an API key, runs the harness in-process through
`LocalDriver`, and prints the graded result.

## Which profile to run

| Profile | Command | Storage | Use it when |
| --- | --- | --- | --- |
| **dev** | `docker-compose.dev.yaml` | in-memory | trying it out, developing against it |
| **prod** | `docker-compose.prod.yaml` | Postgres (persistent volume, migrations auto-applied) | you want results to survive a restart |
| **full** | `bash deploy/compose/full.sh` | Postgres + Temporal + MinIO | the self-hosted flagship: durable batches, schedules, the workspace filesystem |

`prod` additionally wants `POSTGRES_PASSWORD`, a secrets-encryption key (`EVERDICT_SECRETS_KEY`) and an
internal token (`EVERDICT_INTERNAL_TOKEN`); copy `deploy/compose/.env.example` to `.env` first.
`full.sh` generates every missing secret for you and never overwrites one you already set.

> **⚠️ `prod` does not enforce auth by default.** Keycloak is not in that stack, so it behaves as a single
> tenant `default` with authentication off. Put it on a trusted network or behind a reverse proxy. To get
> real auth, either enable `EVERDICT_REQUIRE_AUTH=1` and mint API keys (agents/MCP only — the web UI has
> no login in that mode), or add Keycloak back from `deploy/keycloak/`. Details in
> [`../self-host/overview.md`](../self-host/overview.md).

Behind a corporate proxy or a TLS-intercepting CA, set the standard `HTTP_PROXY` / `HTTPS_PROXY` /
`NO_PROXY` / `CA_CERT` variables — the stacks pass them through at both build and runtime. Full guide:
[`../../runbooks/corporate-proxy.md`](../../runbooks/corporate-proxy.md).

## Next

- [Your first scorecard](first-scorecard.md) — go from one run to a batch with a verdict
- [Connect an agent](connect-an-agent.md) — let Claude Code or CI drive it over MCP
