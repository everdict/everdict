---
kind: wiki
title: "Claude Code plugin"
status: current
updated: 2026-09-16
anchors: [plugin/.mcp.json, plugin/.claude-plugin/plugin.json, plugin/commands/setup.md, plugin/commands/eval.md, plugin/commands/campaign.md, plugin/commands/record.md, plugin/commands/delegate.md, plugin/hooks/hooks.json, plugin/skills/everdict-sdlc/SKILL.md, .claude-plugin/marketplace.json]
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
| **MCP server** | the `everdict` tools, pointed at `${EVERDICT_MCP_URL}` |
| **`everdict` skill** | the domain model and eval workflows, so the session knows what the entities are |
| **`everdict-sdlc` skill** | where the work's record lives — request, campaign, change, knowledge |
| **hooks** | session start loads the service's knowledge; Stop refuses a session that changed code and left no ROUND — the record that carries what was run, with numbers |
| **`/everdict:setup`** | walks a fresh session through connecting and registering its first harness |
| **`/everdict:eval`** | runs an evaluation end-to-end and reports the verdict |
| **`/everdict:campaign`** | opens the request and the campaign the work belongs to |
| **`/everdict:record`** | writes what the session learned back into Everdict |
| **`/everdict:delegate`** | registers the account your delegates run as, then hands an issue to one and supervises it |

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

## The work's record

A repository that names a workspace gets more than tools. At session start the plugin hands the session that
service's decisions, conventions and open requests; at the end, a session that **changed code and recorded
nothing is refused once**, with a break-glass (`EVERDICT_BREAK_GLASS='<reason>'`) whose reason is reported
rather than swallowed. Opt a repository in with one line:

```bash
mkdir -p .everdict && echo '<workspace-id>' > .everdict/workspace   # or export EVERDICT_WORKSPACE
```

Why the record lives there rather than in the repository — and the lineage it buys, from the request to the
code that shipped and what the work taught — is `docs/architecture/development-system-of-record.md` and
`docs/architecture/change-campaign-spec.md`.

## Headless

An interactive session logs in through the browser (OAuth) on first tool use. For CI or a machine with
no interactive session, install from the command line and register the server with an API key instead
— the bundled server sends no credential of its own:

```bash
claude plugin marketplace add everdict/everdict --scope user
claude plugin install everdict@everdict --scope user

export EVERDICT_MCP_URL=https://everdict.internal/mcp
export EVERDICT_API_KEY=ak_…
claude mcp add --transport http everdict "$EVERDICT_MCP_URL" \
  --header "Authorization: Bearer $EVERDICT_API_KEY"
```

Mint the key under **Settings → API keys** in the web app, or with `POST /internal/tenant-keys`
(see [MCP](mcp.md)).

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
