# Suna (Kortix) as an everdict harness — mapping + the gaps it exposes

Suna is a real, popular open-source generalist agent whose topology is exactly what everdict's service-topology
harnesses target: a **backend API + a worker + a frontend**, talking over **Redis**, with an agent that runs tools
(browser, code, files) in a sandbox, plus **MCP** integration, **file attachments**, and — most relevant to us — it
emits its agent traces to **Langfuse**. Running Suna *through* everdict (submit a task → let Suna run → pull its trace →
grade/judge) is the same "eval a real deployed agent" story as the trace-source registry. This doc maps Suna onto the
everdict `ServiceHarnessSpec` and records the concrete gaps that mapping exposes.

## Suna's real topology (legacy branch `SUNA-LEGACY-cutoff`)

Verified from the repo (`backend/pyproject.toml`, `backend/api.py`, `docker-compose.yaml`, `backend/core/`):

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

## The everdict harness mapping (`examples/bundles/suna/suna.harness.template.json`)

What maps cleanly:
- **services** → `backend` / `worker` / `frontend` (per-version warm; the worker `needs` the backend).
- **redis** → a `redis` dependency (`isolateBy: "key-prefix"`) — per-case isolation of the agent-run streams.
- **Supabase** → a `postgres` dependency with `isolateBy: "external"` (BYO managed store; everdict connects, does not provision).
- **async agent run** → `frontDoor.completion.mode = "stream"` (SSE) + `frontDoor.correlate = { mode: "returned", path: "agent_run_id" }` — Suna's initiate returns an `agent_run_id`, then streams. This is exactly the front-door generalization (stream completion + returned correlation).
- **trace** → Suna emits to **Langfuse**; everdict pulls it via the **workspace trace-source registry** (`kind: "langfuse"`, `correlate: "tag"`) — register the Langfuse endpoint once and select it for the `suna` harness. See `docs/service-harness.md` (trace sources).

## The gaps this exposes (grounded in everdict code)

### GAP 1 — the harness's INLINE `traceSource` is narrow (`otel|mlflow`), but real agents emit to Langfuse/etc.
`ServiceHarnessSpec.traceSource` is `{ kind: z.enum(["otel","mlflow"]), endpoint }`
(`packages/contracts/src/harness/harness-spec.ts` `TraceSourceSpecSchema`). Suna uses **Langfuse**, which the inline
field cannot express (and it has no auth/correlate/scope either — the same narrowness the earlier gap analysis found for
service-topology pull). The **workspace trace-source registry** (5 kinds incl. langfuse + auth + `correlate: id|tag` +
scope, resolved per-dispatch by `ServiceTopologyBackend.traceSourceFor`) already fills this — so Suna's Langfuse traces
ARE pullable **via the registry**. The remaining rough edge: a harness author who sets `traceSource` *inline* on the
spec still can't pick langfuse. **Fix (small): widen `TraceSourceSpecSchema` to the 5 kinds + optional `authSecret`
/`correlate`/`service`/`project`, at parity with `CommandTraceSpec` and the workspace registry** — then the inline path
and the registry agree, and Langfuse works either way.

### GAP 2 — the front-door submit is JSON-only; Suna's `/api/agent/initiate` is `multipart/form-data` with file attachments.
`frontDoor.request.bodyTemplate` is a JSON record interpolated and POSTed as `application/json`
(`packages/topology/src/service-backend.ts` → `interpolateTemplate`; `HttpFrontDoorDriver` sends JSON). Suna's initiate
takes a **prompt + optional file attachments** as multipart. So (a) a text-only task can be adapted only if Suna accepts
JSON on that route, and (b) an **attachment-bearing eval case cannot be submitted at all** — there is no way to carry a
file through the front-door. **Fix (medium): a front-door `request.encoding: "json" | "form"` knob + a `files` channel**
(carry an eval-case attachment, or a pre-uploaded reference, into the multipart submit). This is the same "attachments"
capability the user's criteria named, and it generalizes beyond Suna (any agent with an upload-first task).

### GAP 3 — dependency stores are `postgres|redis|minio`; Supabase (pg+auth+storage) and Daytona (sandbox) have no first-class kind.
`TopologyDependencySchema.store = z.enum(["postgres","redis","minio"])`
(`packages/contracts/src/harness/harness-spec.ts`). Suna's **Supabase** is Postgres **plus auth + storage + realtime** —
`isolateBy: "external"` covers "connect to a BYO managed store" (enough for eval: everdict doesn't provision/isolate it),
but everdict has no notion of the auth/storage sub-capabilities. **Daytona** (the per-run agent **sandbox** where the
browser/code tools execute) is not a store at all — it is agent-managed (Suna provisions it via `daytona-sdk` per run),
so everdict neither provisions nor isolates it. **Assessment: mostly OK for eval** — the `external` tier connects Suna to
Supabase, and the Daytona sandbox is Suna's own per-`thread_id` isolation concern. **Not a required fix**, but note that
everdict's `target` (browser|service) does not model an agent-owned remote sandbox, so everdict has no per-case
visibility/isolation guarantee over where Suna's tools actually run. (A deliberate non-goal, like cross-runtime locality.)

### Non-gaps (already covered)
- **Async agent-run streaming** — `completion: "stream"` + `correlate: "returned"` (front-door generalization).
- **MCP** — Suna's MCP is internal (the agent connects to its configured MCP servers); everdict only submits the task, so nothing is needed.
- **Model endpoint** — Suna runs its own litellm; if a harness subprocess needed a gateway, `collectAuthEnv` now forwards `OPENAI_BASE_URL` (the earlier G3 fix).

## Prioritized fixes
1. **GAP 1 (small, high-value):** widen `ServiceHarnessSpec.traceSource` to 5 kinds + auth/correlate/scope → Langfuse (and langsmith/phoenix) work on the inline path, at parity with the workspace registry. Directly unblocks Suna's trace pull without requiring the registry.
2. **GAP 2 (medium):** front-door `request.encoding` + a `files` channel → submit multipart / attachment-bearing tasks. Generalizes to any upload-first agent.
3. **GAP 3 (non-goal for now):** external tier already connects Supabase; Daytona sandbox stays agent-managed.

The bundle (`examples/bundles/suna/`) is declarative: Suna needs an external Supabase + Daytona + provider keys, so it is
not runnable in-repo, but the harness template + this mapping let a team point everdict at their Suna deployment and pull
its Langfuse traces for evaluation today (GAP 1 via the workspace registry), and name the two fixes that make the inline
path and attachments first-class.
