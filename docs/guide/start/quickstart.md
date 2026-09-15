---
kind: wiki
title: "Quickstart"
status: current
updated: 2026-09-15
anchors: [deploy/compose/docker-compose.dev.yaml, deploy/compose/docker-compose.prod.yaml, deploy/compose/full.sh, apps/api/src/api/run/request/submit.ts, packages/application-control/src/require-runtime/require-runtime.ts]
---
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
- **There is no default placement.** Every run and every batch names a runtime; submitting without one
  is a `400`. On this profile, register the reference `local` runtime (in-process on the API container)
  once per restart.
- Source is bind-mounted, so the web hot-reloads and the API rebuilds on change.
- The `agent` service (web chat, <http://localhost:8790>) needs `AGENT_LLM_*` to answer; without it only
  the chat is down.

Check it is alive, and register the runtime:

```bash
curl localhost:8787/healthz
curl -XPOST localhost:8787/runtimes \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/runtimes/local-1.0.0.json
```

Submit a run without any agent credentials — the built-in `scripted` harness replays a canned
trajectory, which is exactly what you want for a smoke test:

```bash
curl -XPOST localhost:8787/runs \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "harness": { "id": "scripted", "version": "latest" },
  "runtime": "local",
  "case": {
    "id": "c1",
    "env": { "kind": "repo", "source": { "files": {} } },
    "task": "...",
    "graders": [{ "id": "steps" }],
    "timeoutSec": 120,
    "tags": []
  }}'
```

The response is the queued run record (`202`, `"status": "queued"`) — submission is asynchronous. Poll
`GET /runs/{id}` with its `id`, or watch it in the web app.

To drive a **real** agent, give the stack a credential: set `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` in your shell or a `.env` before `up`, then use the `claude-code` harness
instead of `scripted`.

## One eval from the CLI, no containers

If you have the repo built and a local Claude subscription, you can skip the stack entirely:

```bash
pnpm install && pnpm build
pnpm everdict run --task "Create ok.txt with the text done" --test "grep -q done ok.txt"
```

This uses the machine's existing login rather than an API key, runs the `claude-code` harness
in-process on the local backend, and prints the graded result as JSON. `--harness scripted` skips the
model entirely.

## Which profile to run

| Profile | Command | Storage | Use it when |
| --- | --- | --- | --- |
| **dev** | `docker-compose.dev.yaml` | in-memory | trying it out, developing against it |
| **prod** | `docker-compose.prod.yaml` | Postgres (persistent volume, migrations auto-applied) | you want results to survive a restart |
| **full** | `bash deploy/compose/full.sh` | Postgres + Temporal + MinIO | the self-hosted flagship: durable batches, schedules, the workspace filesystem |

`prod` refuses to start without `POSTGRES_PASSWORD`, and wants a secrets-encryption key
(`EVERDICT_SECRETS_KEY`) and an internal token (`EVERDICT_INTERNAL_TOKEN`) as well; copy
`deploy/compose/.env.example` to `.env` in the same directory and pass it with `--env-file`.
`full.sh` creates `.env` from `.env.full.example`, generates every missing secret, and never overwrites
one you already set.

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
