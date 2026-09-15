---
kind: wiki
title: "Harness"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/harness/harness-template.ts, packages/contracts/src/harness/harness-spec.ts, apps/api/src/api/harness/harness-template.routes.ts, apps/api/src/api/harness/harness.routes.ts, packages/job-runner/src/registry.ts]
---
# Harness

A harness is the agent under test. Here is a complete one:

```json
{
  "kind": "command",
  "category": "cli-agent",
  "id": "aider",
  "version": "1",
  "setup": ["pip install --quiet aider-chat==0.74.0"],
  "command": "aider --yes --no-git --no-auto-commits --message {{task}} --model {{model}} .",
  "model": "sonnet",
  "env": {},
  "trace": { "kind": "none" }
}
```

That is the entire integration. No adapter, no SDK, no code — a JSON document naming an executable and
how to run it. `{{task}}` is where the case's instruction is substituted (shell-quoted), `{{model}}` the
model.

Register it — the template, then an instance of it, which is what runs and scorecards name:

```bash
curl -XPOST localhost:8787/harness-templates \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/harness-templates/aider.template.json
curl -XPOST localhost:8787/harnesses \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/harness-templates/aider-0.74.0.instance.json
```

Everdict drives your agent **over a process boundary** — it starts the thing, feeds it a task, and
reads back what it did. That boundary is why the product can be harness-agnostic: anything that can be
started and observed can be evaluated, whether or not it was written with evaluation in mind.

## Three kinds

**`command`** — a declaration, like the one above. Reach for this first; most CLI agents need nothing
else. Reference: [`../../command-harness.md`](../../command-harness.md).

**`process`** — a coded adapter, for an agent that needs real integration logic. Two are built in and
need no registration: `claude-code` (`ClaudeCodeHarness`) parses Claude's stream-JSON into trace
events; `scripted` (`ScriptedHarness`) replays a canned trajectory and is what you want for smoke tests.

**`service`** — the agent is a stack, not a binary: an API, a worker, a browser, a vector store, all
deployed for the run and torn down after. It declares a `frontDoor` (where the task is submitted) and a
`traceSource` (where the trace is pulled from).

```json
{
  "kind": "service",
  "category": "topology",
  "id": "my-stack",
  "version": "1",
  "services": [
    { "name": "api",   "image": "ghcr.io/acme/agent-api:1.2.0", "port": 8000 },
    { "name": "redis", "image": "redis:7-alpine", "port": 6379 }
  ],
  "frontDoor":   { "service": "api", "submit": "POST /runs" },
  "traceSource": { "kind": "langfuse", "endpoint": "https://langfuse.internal", "authSecret": "langfuse-key" }
}
```

Reference: [`../../service-harness.md`](../../service-harness.md).

## Template and instance

This is the distinction that trips people up first, and it exists to answer one question: *which exact
thing did we evaluate?*

A **template** (`POST /harness-templates`) is the shape — the kind, the command, the slots it exposes,
and a `category` label. It gets a new version only when the shape changes.

```json
{ "kind": "command", "category": "cli-agent", "id": "aider", "version": "1",
  "command": "aider --message {{task}} --model {{model}}" }
```

An **instance** (`POST /harnesses`) is a template reference plus **pins** — slot to concrete value; a
command template's slots are `image` and `model`. Conventionally one per pull request or commit:

```json
{ "template": { "id": "aider", "version": "1" },
  "id": "aider-pr-482", "version": "1.0.0",
  "pins": { "model": "claude-sonnet-5" } }
```

The engine never sees either. It consumes the **resolved `HarnessSpec`** that
`resolveHarnessInstance(template, instance)` produces. So you can change the model an agent runs under
without republishing its structure, and a scorecard can still name precisely what ran.

Pins can also be **ephemeral** — supplied at submit time, registry untouched. That is how CI evaluates
a candidate image without publishing it:

```bash
curl -XPOST localhost:8787/scorecards \
  -H 'content-type: application/json' -d '{
  "dataset": { "id": "smoke", "version": "latest" },
  "harness": { "id": "my-stack", "version": "latest",
               "pins": { "api": "ghcr.io/acme/agent-api@sha256:9f2c…" } },
  "runtime": "prod-cluster"
}'
```

The swap is recorded in the scorecard's `origin.pinOverrides`, so the record names what actually ran
rather than what was registered. A durable change is `POST /harnesses/:id/pins`, which registers a new
instance version.

## Versions are immutable

Templates and instances live in the registry as `(workspace, id, version)`. `latest` resolves by
semver, and a version, once published, never changes.

That is not bureaucracy — it is the precondition for the product's only real claim. A scorecard records
the version it evaluated. If that version could be edited afterwards, comparing it to next week's
scorecard would mean nothing.

:::tip
Give a harness a new version whenever the **command** changes, not just when the model does. Two runs
whose command differs are not two runs of the same agent, however similar the id.
:::

## What a harness does not do

**It does not score itself.** The harness produces a trace and a snapshot of the world it changed;
[graders and judges](grader-and-judge.md) turn those into measurements. Two different agents solving
the same case are scored by the same code — that is the only reason their numbers are comparable.

**It does not choose where it runs.** That is the runtime and the backend, and a harness stays
infra-agnostic on purpose: it declares *what* it needs, never *where*.

## Traces, or the honest absence of one

Each harness knows how to turn its own native output into `TraceEvent`s. Downstream, everything reads
the normalized form, which is why a judge written once works across agents.

A `command` harness picks its `trace.kind`: `none`, `file` (the command writes its own `TraceEvent`
stream to a file), or a platform to pull from (`otel`, `mlflow`, `langfuse`, `langsmith`, `phoenix`).
When an agent emits nothing parseable, say so — `"trace": { "kind": "none" }`. The run is then graded on
its **outcome** rather than its trajectory, which is a legitimate choice and usually a stricter one.
Inventing a trace format the agent does not emit is how you get judges scoring noise.

Cost and tokens come from the harness's own trace (Claude reports `total_cost_usd`), never estimated.
On a self-hosted runner the harness uses the machine's existing login — no API key needed.

## See also

- [Dataset](dataset.md) — what the harness is pointed at
- [Running Codex](../integrations/codex.md) — a `command` harness, end to end
- [`../../registry.md`](../../registry.md) — versioning and `_shared` resolution
