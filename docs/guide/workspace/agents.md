# Workspace agents

Everdict evaluates agents. It also **runs one for you** — a workspace agent that lives inside the
control plane, sees your evals, and can act on them.

This is not the agent under test. The agent under test is a [harness](../concepts/harness.md) driven
over a process boundary. The workspace agent is a member of your workspace that happens to be a
machine: it holds conversations, files issues, writes to the [filesystem](filesystem.md), and can be
woken by platform events.

## The shortest version

Open a conversation and ask it something:

```bash
curl -XPOST localhost:8787/agents/default/conversations \
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
| `toolSecretBindings` | declared secret name → the secret name your workspace actually holds |

Read the current one:

```bash
curl localhost:8787/agents/default -H 'x-everdict-tenant: default'
```

`GET /agents` lists them, `GET /agents/:id/versions/:version` pins one, and `POST /agents/validate`
checks a spec before you save it.

:::tip
Start from `default` and change `instructions`. Most teams' first useful agent is the stock one told
what their datasets mean and which regressions matter.
:::

## Tools: workspace default, member override

Tools are enabled at two levels. The workspace sets a baseline; a member can opt in or out for
themselves:

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

Secrets are bound by **name**, never by value:

```bash
curl -XPUT localhost:8787/agent/tools/secrets \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "bindings": { "LINEAR_API_KEY": "linear-token" }
}'
```

The left side is what the tool declares it needs; the right side is what your workspace calls it.

## Agents that start themselves

An agent that only answers when spoken to is a chat box. The useful ones react to what happened.

A **subscription** is a selector over platform events plus a reaction:

```bash
curl -XPOST localhost:8787/subscriptions \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "triage regressions",
  "selector": { "kinds": ["scorecard.completed"] },
  "reaction": { "kind": "agent", "agentId": "default",
                "prompt": "Diff this scorecard against its baseline. If cases regressed, open an issue naming them." },
  "enabled": true,
  "cooldownSec": 300
}'
```

Reactions come in three kinds — `agent` (wake an agent), `webhook` (signed delivery to your endpoint),
and `workflow` (a durable chain on Temporal for work that must survive a restart).

:::warning
An agent's own actions emit events too. Everdict stamps agent-caused facts with
`causedBy: agent:<id>:<conversation>` and the trigger guard keys on that prefix, so an agent never wakes
on its own effects. Keep `cooldownSec` anyway — it is the second guard, and the one you control.
:::

## Skills and knowledge

Two things shape what an agent is good at, and both live in the [workspace
filesystem](filesystem.md) as their source of truth:

**Skills** — `skills/<id>/SKILL.md`, plus references pulled in on demand. Progressive disclosure means
a skill costs almost nothing until it is needed, so a workspace can carry many.

**Knowledge** — `knowledge/<id>.md`. Facts about *your* domain that no model has: what your datasets
mean, which regressions matter, what your team calls things.

```bash
curl -XPUT localhost:8787/fs/file \
  -H 'content-type: application/json' -d '{
  "path": "knowledge/retrieval-suite.md",
  "content": "# retrieval-smoke\n\nCases tagged `long-context` are the ones customers hit.\nA regression there is P1; everything else can wait a cycle.\n"
}'
```

Editing that file *is* editing the knowledge entry — save writes the file first, and reads prefer it.

## Agents working together

An agent can delegate to another, and a **team** is a set of agents with a shared conversation. This is
useful when the work genuinely splits — one agent that triages regressions and one that writes the
fix — and wasteful when it does not.

Start with one agent and better instructions. Reach for a team when you can name what each member does
that the other cannot.

## Where the work shows up

Agent runs are [Runs](../concepts/run.md). They appear in the same list, carry the same trace, and cost
the same way — so "what has the agent been doing, and what did it cost" is a question you ask of the
run list, not of a separate agent console.

Files it writes land in the [workspace filesystem](filesystem.md) under `tasks/<conversation-id>/`,
attributed to the agent *and* the member it acted for.

## See also

- [MCP](../integrations/mcp.md) — the same tools, for agents outside Everdict
- [`../../architecture/agent-automation.md`](../../architecture/agent-automation.md) · [`../../architecture/agent-conversations.md`](../../architecture/agent-conversations.md) · [`../../architecture/agent-teams.md`](../../architecture/agent-teams.md)
- [`../../architecture/capability-store.md`](../../architecture/capability-store.md) — where capabilities come from
