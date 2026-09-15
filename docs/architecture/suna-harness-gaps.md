---
kind: wiki
title: "Suna (Kortix) as an everdict harness — mapping + the gaps it exposed"
status: current
updated: 2026-09-15
anchors: [examples/bundles/suna/suna.harness.template.json, packages/topology/src/front-door/front-door-driver.ts]
---
# Suna (Kortix) as an everdict harness — mapping + the gaps it exposed

Suna is a popular open-source generalist agent whose topology is exactly what everdict's service-topology harnesses
target: a **backend API + a worker + a frontend**, talking over **Redis**, with an agent that runs tools (browser,
code, files) in a sandbox, plus **MCP** integration, **file attachments**, and agent traces exported to **Langfuse**.
Running Suna through everdict (submit a task → let Suna run → pull its trace → grade/judge) is the "eval a real
deployed agent" story. This page maps Suna onto `ServiceHarnessSpec` and records what the mapping exposed and how
each gap was closed.

## Suna's topology (legacy branch `SUNA-LEGACY-cutoff`)

As read from that branch (`backend/pyproject.toml`, `backend/api.py`, `docker-compose.yaml`, `backend/core/`):

| piece | what it is |
|---|---|
| `backend` (FastAPI, :8000) | the API + the `agentpress` agent loop |
| `worker` | consumes agent runs from **Redis streams** (backend↔worker message passing: `redis` streams + `set_stop_signal` + stream-cleanup) |
| `frontend` (Next.js, :3000) | the client |
| **redis** (`redis==5.2.1`) | agent-run streams / pub-sub — the broker between backend and worker |
| **Supabase** (`supabase==2.17.0`) | Postgres + auth + storage — **external/managed**, explicitly not in the compose |
| **Daytona** (`daytona-sdk`) | the **sandbox** where the agent runs browser/code/file tools (agent-provisioned, per run) |
| **Langfuse** (`langfuse==2.60.5`) | the observability platform Suna exports its traces to |
| `core/mcp_module` | MCP integration | `core/files` | attachments | `core/tools` | browser/files/etc |
| `litellm` | model gateway (multi-provider) |

## The harness mapping (`examples/bundles/suna/suna.harness.template.json`)

- **services** → `backend` / `worker` / `frontend` (per-version warm; `worker` and `frontend` `needs` the backend).
- **redis** → a `redis` dependency (`isolateBy: "key-prefix"`) — per-case isolation of the agent-run streams.
- **Supabase** → a `postgres` dependency with `isolateBy: "external"` (BYO managed store; everdict connects, does not
  provision).
- **async agent run** → `frontDoor.completion.mode = "stream"` + `frontDoor.correlate = { mode: "returned", path:
  "agent_run_id" }` — Suna's initiate returns an `agent_run_id`, then streams
  ([completion-stream-callback.md](./completion-stream-callback.md)).
- **submit** → `POST /api/agent/initiate` with `request.encoding: "form"`, `bodyTemplate { prompt, thread_id }` and a
  `files` attachment.
- **trace** → an inline `traceSource: { kind: "langfuse", authSecret, correlate: "tag" }`; the workspace trace-source
  registry can supply the same source instead (see `docs/service-harness.md`, trace sources).

The bundle is declarative: Suna needs an external Supabase, Daytona and provider keys, so it is not runnable in the
repository, but a team can point everdict at their Suna deployment with it.

## The gaps the mapping exposed

### GAP 1 — the inline trace source could not name Langfuse (closed)

`TraceSourceSpecSchema` (`packages/contracts/src/harness/harness-spec.ts`, shared by `ServiceHarnessSpec.traceSource`
and the runtime spec's topology trace source) used to be `otel | mlflow` + endpoint, while the workspace registry
already supported Langfuse. It now carries the five kinds (`otel`, `mlflow`, `langfuse`, `langsmith`, `phoenix`) plus
`authSecret` / `correlate` / `correlateTag` / `service` / `project`, so the inline path and the registry agree. For a
runtime's trace source, `buildTopologyBackend` (`apps/api/src/core/execution/topology-backend.ts`) resolves
`authSecret` from the tenant's secrets.

### GAP 2 — the front-door submit was JSON-only (closed)

Suna's initiate is `multipart/form-data` with optional attachments, so an attachment-bearing case could not be
submitted. `FrontDoorRequestSchema` now has `encoding: "json" | "form"` and `files: [{ field, from, filename? }]`.
`resolveFrontDoorFiles` (`packages/topology/src/service-backend.ts`) takes each file from the case's repo-env inline
`source.files` — the only supported source; a missing file fails the run — and the driver's `encodeBody` sends the
payload as text parts and the files as file parts, on both the submit and the stream paths.

### GAP 3 — Supabase and Daytona have no first-class kind (accepted)

`TopologyDependencySchema.store` is `postgres | redis | minio`. Supabase is Postgres plus auth, storage and realtime;
`isolateBy: "external"` connects Suna to it, which is enough for evaluation, but everdict has no notion of the
sub-capabilities. Daytona is not a store: Suna provisions a sandbox per run with `daytona-sdk`, so everdict neither
provisions nor isolates it, and its `target` kinds do not model an agent-owned remote sandbox. everdict therefore has
no per-case visibility or isolation guarantee over where Suna's tools run — a deliberate non-goal.

### Not gaps

- **MCP** — Suna connects to its own configured MCP servers; everdict only submits the task.
- **Model endpoint** — Suna runs its own litellm; when a harness subprocess needs a gateway, the job runner's auth env
  forwarding carries `OPENAI_BASE_URL`.
