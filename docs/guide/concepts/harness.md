---
kind: wiki
title: "Harness"
status: current
updated: 2026-08-11
---
# Harness

A harness is the agent under test. Here is a complete one:

```json
{
  "kind": "command",
  "category": "cli-agent",
  "id": "codex",
  "version": "1",
  "setup": [],
  "command": "codex exec --sandbox workspace-write --skip-git-repo-check {{task}} < /dev/null",
  "model": "gpt-5-codex",
  "env": {},
  "trace": { "kind": "none" }
}
```

That is the entire integration. No adapter, no SDK, no code — a JSON document naming an executable and
how to run it. `{{task}}` is where the case's instruction is substituted.

Register it:

```bash
curl -XPOST localhost:8787/harnesses \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/harness-templates/aider.template.json
```

Everdict drives your agent **over a process boundary** — it starts the thing, feeds it a task, and
reads back what it did. That boundary is why the product can be harness-agnostic: anything that can be
started and observed can be evaluated, whether or not it was written with evaluation in mind.

## Three kinds

**`command`** — a declaration, like the one above. Reach for this first; most CLI agents need nothing
else. Reference: [`../../command-harness.md`](../../command-harness.md).

**`process`** — a coded adapter, for an agent that needs real integration logic. `ClaudeCodeHarness`
parses Claude's stream-JSON into trace events; `ScriptedHarness` replays a canned trace and is what you
want for smoke tests.

**`service`** — the agent is a stack, not a binary: an API, a worker, a browser, a vector store, all
deployed for the run and torn down after.

```json
{
  "kind": "service",
  "id": "browser-use",
  "version": "1.2.0",
  "services": [
    { "name": "api",   "image": "ghcr.io/acme/agent-api:1.2.0", "port": 8000 },
    { "name": "redis", "image": "redis:7-alpine" }
  ],
  "target": { "acquire": { "mode": "service", "capacity": 4 } },
  "trace": { "kind": "langfuse" }
}
```

Reference: [`../../service-harness.md`](../../service-harness.md).

## Template and instance

This is the distinction that trips people up first, and it exists to answer one question: *which exact
thing did we evaluate?*

A **template** is the shape — the kind, the command, the slots it exposes. It gets a new version only
when the shape changes.

```json
{ "kind": "command", "id": "aider", "version": "1",
  "command": "aider --message {{task}} --model {{model}}" }
```

An **instance** is a template reference plus **pins** — slot to concrete value. Conventionally one per
pull request or commit:

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
  "harness": { "id": "aider", "version": "latest",
               "pins": { "image": "ghcr.io/acme/agent@sha256:9f2c…" } }
}'
```

The swap is recorded in the scorecard's `origin.pinOverrides`, so the record names what actually ran
rather than what was registered.

## Versions are immutable

Harnesses live in the registry as `(workspace, id, version)`. `latest` resolves by semver, and a
version, once published, never changes.

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

When an agent emits nothing parseable, say so — `"trace": { "kind": "none" }`. The run is then graded on
its **outcome** rather than its trajectory, which is a legitimate choice and usually a stricter one.
Inventing a trace format the agent does not emit is how you get judges scoring noise.

Cost and tokens come from the harness's own trace (Claude reports `total_cost_usd`), never estimated.
Under `LocalDriver` the harness uses the machine's existing login — no API key needed.

## See also

- [Dataset](dataset.md) — what the harness is pointed at
- [Running Codex](../integrations/codex.md) — this page's `command` example, end to end
- [`../../registry.md`](../../registry.md) — versioning and `_shared` resolution
