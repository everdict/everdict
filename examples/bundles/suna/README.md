# suna — Kortix Suna as an everdict service-topology harness

[Suna](https://github.com/kortix-ai/suna) (Kortix) is an open-source generalist agent whose topology is exactly what
everdict's service-topology harnesses target: **backend API + worker + frontend**, talking over **Redis**, an agent that
runs browser/code/file tools in a **Daytona sandbox**, **MCP** integration, **file attachments**, and it exports its
agent traces to **Langfuse**. This bundle maps Suna onto a `ServiceHarnessSpec` so you can submit tasks to a Suna
deployment and **pull its Langfuse traces to grade/judge** them — the "eval a real deployed agent" story.

> Verified against the legacy branch `SUNA-LEGACY-cutoff` (the current `main` is a TS/Bun rewrite that uses
> Stagehand/Playwright instead of a `browser-use`-style tool; the topology — server/worker/frontend + Redis + Supabase +
> Langfuse + MCP + attachments — is the same).

## Files
- `suna.harness.template.json` — the service-topology harness (backend/worker/frontend services · redis + Supabase[external]
  dependencies · front-door = `POST /api/agent/initiate` with `completion: stream` + `correlate: returned agent_run_id`).

## How to evaluate Suna through everdict (today)

Suna needs an external Supabase + Daytona + provider keys, so it is **not runnable in-repo** — point everdict at *your*
Suna deployment:

1. **Register the harness** from the template (fill the service `image`s / slot pins + the backend's env: `REDIS_*`,
   `SUPABASE_URL`/keys, `LANGFUSE_*`, LLM keys — as workspace secret refs).
2. **Register your Suna Langfuse as a workspace trace source** and select it for the harness — this is what pulls the
   agent's trace after a case:
   ```
   PUT /workspace/trace-sources { name:"suna-langfuse", kind:"langfuse", endpoint:"https://cloud.langfuse.com",
                                  authSecretName:"langfuse-key", correlate:"tag" }
   PUT /harnesses/suna/trace-source { source:"suna-langfuse" }
   ```
   (Suna tags its Langfuse traces so everdict correlates by the injected run id — see `docs/service-harness.md`.)
3. **Run a scorecard** (dataset × the `suna` harness). everdict submits each task to Suna's `/api/agent/initiate`, streams
   to completion, then pulls that run's Langfuse trace and applies the graders/judges.

## What this exposes in everdict

Building this harness surfaced concrete everdict gaps — see **`docs/architecture/suna-harness-gaps.md`** for the grounded
analysis. Two of them are now **fixed** (and the template above uses them):

- **GAP 1 — SHIPPED:** the inline `traceSource` is widened to 5 kinds + auth/correlate/scope, so it can point at
  **Langfuse** with tag correlation (`traceSource: {kind:"langfuse", correlate:"tag", authSecret:…}`), at parity with the
  workspace trace-source registry.
- **GAP 2 — SHIPPED:** the front-door gains `request.encoding: "form"` + a `files` channel, so Suna's
  `multipart/form-data` initiate with **file attachments** is expressible (`files: [{field, from}]`, resolved from the
  case's inline repo files).
- **GAP 3 (non-goal):** Supabase connects via the `external` dependency tier; Daytona (the agent's per-run sandbox) stays
  agent-managed — everdict doesn't model an agent-owned remote sandbox.
