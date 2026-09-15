---
kind: wiki
title: "Workspace agents"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/harness/agent-spec.ts, apps/api/src/api/agent/agent.routes.ts, apps/api/src/api/agent/agent-tool.routes.ts, packages/contracts/src/records/subscription.ts]
---
# Workspace agents

Everdict evaluates agents. It also **runs one for you** — a workspace agent that lives beside the
control plane, sees your evals, and can act on them.

This is not the agent under test. The agent under test is a [harness](../concepts/harness.md) driven
over a process boundary. The workspace agent is a member of your workspace that happens to be a
machine: it holds conversations, files issues, writes to the [filesystem](filesystem.md), and can be
woken by platform events.

## The shortest version

In the web app it is the assistant chat. Over HTTP it is the agent service (`:8790` on the Compose
stacks; it needs a model before it boots — `AGENT_LLM_API_KEY` + `AGENT_LLM_MODEL`, or `AGENT_MODEL` naming a
registered workspace model, which only works with a database; see the self-host overview).
Open a conversation, then ask it something:

```bash
curl -XPOST localhost:8790/agent/sessions \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{"title":"regressions"}'
# → { "id": "<session-id>", … }

curl -XPOST localhost:8790/agent/sessions/<session-id>/chat \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "message": "Which cases regressed between the last two scorecards on the retrieval dataset?"
}'
```

It has the control plane's own tools, so it answers by *reading your data* — listing scorecards,
diffing them, and naming the cases — not by guessing from the question.

## What an agent is made of

An agent is a versioned document (`AgentSpec`), so a change to how it behaves is a new version rather
than a silent edit:

| Field | What it does |
| --- | --- |
| `instructions` | workspace context appended to the base prompt — the CLAUDE.md of this agent |
| `capabilities` | capabilities adopted from the Store, pinned by immutable version (`mcp` · `code` · `skill`) |
| `mcpServers` | a raw MCP server wired by hand — the escape hatch when something is not in the Store |
| `disabledDefaults` | first-party defaults (web search, PDF, integration tools) this workspace turns **off** |
| `toolSecretBindings` | per tool: declared secret name → the secret name your workspace actually holds |
| `model` | the registered model that powers it (unset = the agent service's default) |
| `task` · `triggers` · `enabled` | what it does when an event wakes it, which events, and whether it may be woken |

Read the current one:

```bash
curl localhost:8787/agents/default/versions/latest -H 'x-everdict-tenant: default'
```

`GET /agents` lists them, `GET /agents/:id/versions/:version` pins one, and `POST /agents/validate`
checks a spec before you save it. In the web app this is **Settings → Agent**.

:::tip
Start from `default` and change `instructions`. Most teams' first useful agent is the stock one told
what their datasets mean and which regressions matter.
:::

## Tools: workspace default, member override

Tools are enabled at two levels. The workspace sets a baseline; a member can opt in or out for
themselves (**Settings → Tools**):

```bash
curl -XPUT localhost:8787/agent/tools \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "key": "default:web-search",
  "enabled": false
}'
```

`enabled` takes three values, and the third is the point: `true` = on for me, `false` = off for me,
`null` = follow the workspace. A member who never expresses a preference tracks the workspace default
forever, including when it changes.

Secrets are bound by **name**, never by value, per tool (the key is percent-encoded into the path):

```bash
curl -XPUT localhost:8787/agent/tools/default%3Aweb-search/secrets \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "bindings": { "TAVILY_API_KEY": "SEARCH_KEY" }
}'
```

The left side is what the tool declares it needs; the right side is what your workspace calls it.

## Agents that start themselves

An agent that only answers when spoken to is a chat box. The useful ones react to what happened.

A **subscription** is a selector over platform events plus a reaction (**Settings → Subscriptions**):

```bash
curl -XPOST localhost:8787/subscriptions \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "triage regressions",
  "selector": { "kinds": ["scorecard.completed"],
                "filters": [{ "field": "passRate", "op": "lt", "value": 1 }] },
  "reaction": { "kind": "agent", "agentId": "regression-triage" },
  "governance": { "enabled": true, "cooldownSec": 300 }
}'
```

What the woken agent does is its own `task` field — "diff this scorecard against its baseline; if cases
regressed, open an issue naming them" — so the instruction is versioned with the agent, not buried in
a subscription.

Reactions come in three kinds — `agent` (wake an agent), `webhook` (delivery to your endpoint,
HMAC-signed when you give it a `secret`), and `workflow` (up to five agent steps chained on Temporal, for
work that must survive a restart; skipped when no Temporal is configured).

:::warning
An agent's own actions emit events too. Everdict stamps agent-caused facts with
`causedBy: agent:<id>:<conversation>` and the trigger guard keys on that prefix, so an agent never wakes
on its own effects. Keep `cooldownSec` anyway — it is the second guard, and the one you control.
:::

## What it knows when it starts

An agent's usefulness is mostly decided before it reads your message: the workspace instructions in
front of it, the per-turn environment block, and — the part worth reading on its own — the mechanism
by which it inherits what your workspace already concluded, projected onto the *version* the task is
about. See [What the agent knows](agent-context.md).

## Skills and knowledge

Two things shape what an agent is good at, and both live in the [workspace
filesystem](filesystem.md) as their source of truth:

**Skills** — `skills/<id>/SKILL.md`, plus supporting files under `skills/<id>/files/` pulled in on
demand. Progressive disclosure means a skill costs almost nothing until it is needed, so a workspace can
carry many.

**Knowledge entries** — `knowledge/<id>.md`. Facts about *your* domain that no model has: what your
datasets mean, which regressions matter, what your team calls things. Create one on the web app's
**Knowledge** page or through the API, then edit its file like any other:

```bash
curl -XPOST localhost:8787/knowledge/entries \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "kind": "convention",
  "title": "Long-context regressions are P1",
  "body": "Cases tagged `long-context` are the ones customers hit. A regression there is P1; everything else can wait a cycle.",
  "refs": [{ "type": "dataset", "key": "retrieval-smoke" }],
  "visibility": "workspace"
}'
```

Editing `knowledge/<id>.md` *is* editing the entry — a save writes the file first, and reads prefer it.

## Agents working together

An agent can hand a scoped sub-task to a one-shot sub-agent (`spawn_agent`), register a persistent
**teammate** with its own standing task that platform events can wake (`spawn_teammate`), and pass work
through the task ledger (`create_task`, then `wait_for` its completion). This is useful when the work
genuinely splits — one agent that triages regressions and one that writes the fix — and wasteful when
it does not.

Start with one agent and better instructions. Reach for a teammate when you can name what it does that
the first agent cannot.

## Where the work shows up

Agent turns and activations are [Runs](../concepts/run.md) of kind `agent`. They appear in the same
list, carry the same trace, and cost the same way — so "what has the agent been doing, and what did it
cost" is a question you ask of the run list, not of a separate agent console.

Files it writes land in the [workspace filesystem](filesystem.md) under `tasks/<conversation-id>/`,
attributed to the agent *and* the member it acted for.

## See also

- [MCP](../integrations/mcp.md) — the same tools, for agents outside Everdict
- [`../../architecture/agent-automation.md`](../../architecture/agent-automation.md) · [`../../architecture/agent-conversations.md`](../../architecture/agent-conversations.md) · [`../../architecture/agent-teams.md`](../../architecture/agent-teams.md)
- [`../../architecture/capability-store.md`](../../architecture/capability-store.md) — where capabilities come from
