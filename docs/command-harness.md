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
  "trace": { "kind": "none" }          // | { "kind":"otel"|"mlflow", "endpoint":"…" }
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
- **`none`** — outcome-graded only (repo diff + `tests-pass`); no trajectory/cost. aider is objectively graded,
  so this already evaluates it.
- **`otel` / `mlflow`** — after the command, the trace is pulled via `@assay/trace`
  (`OtelTraceSource`/`MlflowTraceSource`) by `ASSAY_RUN_ID`. The agent must tag its spans with that id
  (`OTEL_RESOURCE_ATTRIBUTES=assay.run_id=…` is injected) — i.e. an instrumented agent; uninstrumented CLIs use
  `none`.

## Security
`setup`/`command` are **arbitrary user code** → they run only inside a **trust zone** (gVisor/Kata + per-tenant
namespace + warm-pool keying), the isolation the runtime already enforces for untrusted tenant code. Pin
image/install versions.

## Verified
- **Deterministic** (`packages/harnesses/src/command.test.ts`): setup ordering; `{{task}}` shell-quoting + env
  injection (`ASSAY_RUN_ID`); `trace:none` → no events; `trace:otel` → pulls by run id; setup failure → error.
- **Live, no key** (`scripts/live/command-harness.mjs`): a user-declared `command` spec
  (`echo … > result.txt`) dispatched through `LocalBackend` → ran in the real `LocalDriver` sandbox →
  `CaseResult` with `result.txt` in the git-diff snapshot. **Zero code, zero LLM key.**
- **aider live, real model** (`scripts/live/aider-litellm-live.mjs`): the real OSS coding agent **aider**
  (`setup: pip install aider-chat` into a venv) fixed a seeded bug (`add` returned `a-b`) using
  **gpt-5.4-mini** served by workclaw's LiteLLM (`--model openai/chatgpt/gpt-5.4-mini` + `OPENAI_API_BASE`/
  `OPENAI_API_KEY`), and Assay graded it **tests-pass = PASS** — end-to-end, zero adapter code. Gotchas for a
  LiteLLM responses-bridged model: aider needs **`--no-stream`** (streaming garbles the bridged output → no edit
  applied) and **`--edit-format whole`** (robust for weaker models). On Nomad/K8s the key comes from the
  workspace secret store and the base agent image needs `python`/`pip`. See `examples/harnesses/aider-litellm.json`.
