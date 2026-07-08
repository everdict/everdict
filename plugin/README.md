# Everdict — Claude Code plugin

Bring the [Everdict](https://github.com/everdict/everdict) agent-evaluation runtime into **any**
Claude Code session. Everdict runs an agent harness (Claude Code, Codex, any CLI, or a multi-service
topology) and **scores** it — repeatably, with regression tracking and leaderboards.

This plugin gives a session that has **no** Everdict context two things:

1. **The Everdict MCP tools** — an `everdict` MCP server (`list_datasets`, `register_harness`,
   `run_scorecard`, `get_scorecard`, `diff_scorecards`, …) pointed at your control plane.
2. **The domain context** — the `everdict` skill (domain model + eval workflows) so Claude knows
   *what the entities are* and *how to drive an evaluation end-to-end*, plus `/everdict:setup` and
   `/everdict:eval` commands.

## Install

```bash
# From the public Everdict repo (it is also a plugin marketplace):
/plugin marketplace add everdict/everdict
/plugin install everdict@everdict
```

Or headless:

```bash
claude plugin marketplace add everdict/everdict --scope user
claude plugin install everdict@everdict --scope user
```

## Configure

The bundled `everdict` MCP server reads its endpoint from an environment variable — set it to your
control plane's `/mcp` URL before launching Claude Code:

```bash
export EVERDICT_MCP_URL="https://everdict.your-company.com/mcp"   # or http://localhost:8787/mcp for local dev
```

Auth is "login like Linear MCP": interactive sessions do a **browser OAuth login** (Keycloak) on
first tool use; headless agents/CI use an **API key** —

```bash
claude mcp add --transport http everdict "$EVERDICT_MCP_URL" \
  --header "Authorization: Bearer $EVERDICT_API_KEY"
```

Run `/everdict:setup` for the guided version, then `/everdict:eval` to evaluate the current
project's agent. See [`docs/mcp.md`](https://github.com/everdict/everdict/blob/main/docs/mcp.md) for
the full tool reference.

## What's inside

```
plugin/
├── .claude-plugin/plugin.json   # manifest
├── .mcp.json                    # the everdict MCP server (url via ${EVERDICT_MCP_URL})
├── skills/everdict/
│   ├── SKILL.md                 # the flagship context: mental model + entities + workflow
│   └── references/              # domain-model.md · mcp-tools.md · workflows.md (read on demand)
└── commands/
    ├── setup.md                 # /everdict:setup — connect + auth
    └── eval.md                  # /everdict:eval  — guided evaluation of the current project
```
