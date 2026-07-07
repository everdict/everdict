# Declarative command harness (bring any CLI agent, no code)

The `process` path used to be **code-bound**: a harness id mapped to a TypeScript adapter (`ClaudeCodeHarness`,
`ScriptedHarness`) baked into the agent image. So onboarding a new CLI agent (aider, etc.) meant a PR + image
rebuild. The **`command` harness** removes that: a CLI agent is declared as **data** (a `HarnessSpec`) and a
single generic `CommandHarness` interprets it. A SaaS user registers a spec → no code from us.

## The spec (`kind: "command"`)
```jsonc
{
  "kind": "command",
  "id": "aider", "version": "0.74.0",
  "image": "…",                       // optional: dispatch image (default = agent image). use setup to install.
  "setup": ["pip install --quiet aider-chat==0.74.0"],   // run once in the sandbox before the task
  "command": "aider --yes --no-git --message {{task}} --model {{model}} .",
  "model": "sonnet",
  "env": { },                          // extra env (LLM keys come from per-tenant secrets, not here)
  "trace": { "kind": "none" }          // | { "kind":"otel"|"mlflow"|"langfuse"|"langsmith"|"phoenix", "endpoint":"…",
                                       //     "collect":"job"|"control-plane", "authSecret":"…"?,
                                       //     mlflow: "correlate":"id"|"tag"?, "experiment":"…"? · phoenix: "project" }
}
```
Template tokens in `command`: **`{{task}}`** (shell-quoted automatically — don't wrap it in quotes),
`{{model}}`, `{{run_id}}`.

## How it runs
The control plane resolves the spec from the registry and **embeds it in the `AgentJob`** (`harnessSpec`). The
dispatched agent's `makeHarness` sees `kind:"command"` and builds the generic `CommandHarness`
(`@assay/harnesses`), which: runs `setup` → runs the templated `command` in the sandbox (`ComputeHandle.exec`,
cwd `work`, with `ASSAY_RUN_ID` + `spec.env` injected) → extracts the trace. The repo `Environment` + `Graders`
are unchanged, so evaluation (git-diff snapshot, `tests-pass`, …) works as for any harness. Same process-dispatch
path → runs on **Local / Nomad / K8s** backends with the existing isolation.

## Trace extraction
- **`none`** — no trajectory/cost. The command's **stdout (tail 32k) becomes the final assistant `message`**
  trace event, so prompt-QA benchmarks (`answer-match`/judge — e.g. OfficeQA-style) grade a black-box CLI's
  printed answer; outcome grading (repo diff + `tests-pass`) is unchanged. A non-zero exit yields an `error`
  trace event (never silently swallowed).
- **`otel` / `mlflow` / `langfuse` / `langsmith` / `phoenix`** — after the command, the trace is pulled via
  `@assay/trace` `buildTraceSource` (the same 5 kinds as pull-ingest; phoenix needs `project`) by
  `ASSAY_RUN_ID`. The agent must tag its spans with that id
  (`OTEL_RESOURCE_ATTRIBUTES=assay.run_id=…` is injected) — i.e. an instrumented agent; uninstrumented CLIs use
  `none`. **Where the pull happens** is the `collect` knob (2-phase collection,
  `docs/architecture/streaming-case-pipeline.md` D4): `"job"` (default) — `runCase` calls the harness's
  `collectTrace(runId)` **after compute release** (sandbox not held during flush lag; works for
  cluster-internal endpoints); `"control-plane"` — the job ends at execution, the result carries
  `traceRef {kind, endpoint, runId}`, and `executeCase` pulls + grades the deferred observation graders on the
  control plane (only if the endpoint is reachable from there). **Auth**: `authSecret` (SecretStore name →
  verbatim `Authorization`; resolved into transient `trace.auth` for in-job pulls, re-resolved by name for
  control-plane pulls). **Correlation** (mlflow): `correlate:"id"` (default — runId IS the platform trace id,
  pull-ingest convention) or `"tag"` — the agent tags its trace `assay.run_id=$ASSAY_RUN_ID` and Assay
  resolves it via `traces/search` (requires `experiment` scope). Empty pulls retry (3×, flush lag).

## Security
`setup`/`command` are **arbitrary user code** → they run only inside a **trust zone** (gVisor/Kata + per-tenant
namespace + warm-pool keying), the isolation the runtime already enforces for untrusted tenant code. Pin
image/install versions.

## Verified
- **Deterministic** (`packages/harnesses/src/command.test.ts`): setup ordering; `{{task}}` shell-quoting + env
  injection (`ASSAY_RUN_ID`); `trace:none` → stdout = final assistant message (empty stdout → no events);
  exit≠0 → `error` event; `trace:otel` → pulls by run id (stdout not emitted); setup failure → error.
- **2-phase collection live, real MLflow 3.14** (`scripts/live/trace-collect-mlflow.mjs`): `collect:"job"`
  round trip (injected `ASSAY_RUN_ID` → post-release pull of real spans → steps/cost derived) +
  `collect:"control-plane"` (job returns `traceRef`; `executeCase` pulls + grades deferred observation
  graders) + dead-endpoint soft-degrade. All PASS.
- **Live, no key** (`scripts/live/command-harness.mjs`): a user-declared `command` spec
  (`echo … > result.txt`) dispatched through `LocalBackend` → ran in the real `LocalDriver` sandbox →
  `CaseResult` with `result.txt` in the git-diff snapshot. **Zero code, zero LLM key.**
- **aider live, real model** (`scripts/live/aider-litellm-live.mjs`): the real OSS coding agent **aider**
  (`setup: pip install aider-chat` into a venv) fixed a seeded bug (`add` returned `a-b`) using
  **gpt-5.4-mini** served by workclaw's LiteLLM (`--model openai/chatgpt/gpt-5.4-mini` + `OPENAI_API_BASE`/
  `OPENAI_API_KEY`), and Assay graded it **tests-pass = PASS** — end-to-end, zero adapter code. Gotchas for a
  LiteLLM responses-bridged model: aider needs **`--no-stream`** (streaming garbles the bridged output → no edit
  applied) and **`--edit-format whole`** (robust for weaker models). See `examples/harnesses/aider-litellm.json`.
- **aider live on Nomad** (`scripts/live/aider-nomad.mjs`): the same aider+gpt-5.4-mini eval run **inside a real
  Nomad alloc** (docker driver) → `tests-pass = PASS` in ~10s. `NomadBackend` injects the LiteLLM key via
  `secretEnv` (→ alloc env → inherited by aider); the base **`assay-agent` image bakes in `python3` + `aider`**
  (`packages/agent/Dockerfile`) so runs are fast and `setup` is empty. **Gotcha (container→host networking):** use
  the **docker bridge gateway `172.17.0.1`** for `OPENAI_API_BASE`, not the host LAN IP — from inside the alloc
  the LAN IP TCP-connects but the model-completion response doesn't return cleanly, hanging aider until timeout;
  the gateway path works in ~10s.
- **aider on K8s (kind)** (`scripts/live/aider-k8s.mjs`, `K8sBackend({hostNetwork})`): **PASS** — real aider fixes
  the seeded bug using **gpt-5.4-mini** (workclaw LiteLLM) inside a real **K8s Job** → `tests-pass` in ~13 s.
  **Nomad↔K8s real-agent parity complete** (Local + Nomad + K8s all green). Two things were needed:
  - **Networking:** a kind pod can't reach the host's host-network LiteLLM normally, so the eval pod uses
    **`hostNetwork: true`** (`K8sBackend.hostNetwork`) and the node is joined to the docker default bridge
    (`docker network connect bridge assay-control-plane`) → reaches `172.17.0.1:4000`. (Normal-pod paths —
    direct, or Service+manual-Endpoints — can't reach the host at all in kind.)
  - **Model name (the real root cause of the earlier "hang"):** this litellm version routes any model whose name
    contains **`chatgpt/`** to its native **ChatGPT-OAuth device-code** provider, which blocks forever waiting
    for an interactive login in a non-interactive pod. (SLICE-25's "httpx hangs" was a misdiagnosis — raw `httpx`
    POSTs fine; only litellm's OAuth path stalls.) Fix: give aider a **clean alias** (`gpt-5.4-mini`, no
    `chatgpt/` prefix) registered on the LiteLLM proxy → litellm uses the plain OpenAI-compatible path. Use
    `--model openai/gpt-5.4-mini`. **Production note:** in a real cluster, run LiteLLM as an **in-cluster
    Service** (normal pod network) and expose models under non-`chatgpt/` names.
