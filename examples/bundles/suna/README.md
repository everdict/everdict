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
analysis. In short:

- **GAP 1 (small):** the harness's INLINE `traceSource` is `otel|mlflow` only — Suna uses **Langfuse**. The workspace
  trace-source registry (5 kinds, incl. langfuse) already pulls it; widening the inline field to parity is the clean fix.
- **GAP 2 (medium):** the front-door submits JSON only, but Suna's initiate is `multipart/form-data` with **file
  attachments** — everdict needs a `request.encoding` + a `files` channel to submit upload-bearing tasks.
- **GAP 3 (non-goal):** Supabase connects via the `external` dependency tier; Daytona (the agent's per-run sandbox) stays
  agent-managed — everdict doesn't model an agent-owned remote sandbox.
