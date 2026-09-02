---
kind: wiki
title: "Claude Code plugin"
status: current
updated: 2026-08-11
---
# Claude Code plugin

Two commands give any Claude Code session the ability to run and read evaluations:

```bash
export EVERDICT_MCP_URL=http://localhost:8787/mcp   # put this in your shell profile
```

then, inside Claude Code:

```
/plugin marketplace add everdict/everdict
/plugin install everdict@everdict
```

The Everdict repository is itself the plugin marketplace, so there is nothing else to host.

## What you just installed

A raw MCP connection gives an agent *tools*. It does not give it *understanding* — a session that can
call `run_scorecard` but does not know what a harness is will flail. The plugin ships both halves:

| Piece | What it is |
| --- | --- |
| **MCP server** | the `everdict` tools, pointed at your control plane |
| **`everdict` skill** | the domain model and eval workflows, so the session knows what the entities are |
| **`/everdict:setup`** | walks a fresh session through connecting and registering its first harness |
| **`/everdict:eval`** | runs an evaluation end-to-end and reports the verdict |

The skill uses progressive disclosure: a short `SKILL.md` plus references
(`domain-model.md`, `workflows.md`, `mcp-tools.md`) pulled in on demand, so it costs little until it is
needed.

## Try it

```
/everdict:eval
```

Or just say what you want — the session has the tools and the vocabulary:

> "Run the retrieval dataset against my `claude-code` harness, three trials, and tell me whether
> anything regressed against last week."

## Headless

For CI or a machine with no interactive session, install without the marketplace flow and authenticate
with an API key rather than OAuth:

```bash
export EVERDICT_MCP_URL=https://everdict.internal/mcp
export EVERDICT_API_KEY=ak_…
```

Mint the key from the account page in the web app, or `POST /internal/tenant-keys`.

## Two things people conflate

**Claude Code as the driver** — what this page is about. Claude Code operates Everdict.

**Claude Code as the agent under test** — a `claude-code` harness that Everdict starts, scores, and
compares. That is [Harness](../concepts/harness.md), and the two are independent: you can drive
Everdict from Claude Code while evaluating a completely different agent.

:::tip
Both at once is the point. Ask the session to evaluate a change it just made to its own harness
configuration, and the verdict lands in the same conversation that caused it.
:::

## See also

- [MCP](mcp.md) — the same surface for any other client
- [`../../../plugin/README.md`](https://github.com/everdict/everdict/blob/main/plugin/README.md) — the plugin's own README
