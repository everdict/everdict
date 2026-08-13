# Everdict — Claude Code / Codex plugin

Bring the [Everdict](https://github.com/everdict/everdict) agent-evaluation runtime into **any**
Claude Code or Codex session. Everdict runs an agent harness (Claude Code, Codex, any CLI, or a
multi-service topology) and **scores** it — repeatably, with regression tracking and leaderboards.

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

**Codex** installs the same marketplace, and gets the skill:

```bash
codex plugin marketplace add everdict/everdict
codex plugin add everdict@everdict
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

### Codex — register the MCP server yourself

The plugin bundles no MCP server **for Codex**, on purpose: Codex does not expand `${VAR}` inside a
plugin's `.mcp.json`, so a bundled `"url": "${EVERDICT_MCP_URL}"` would arrive as that literal string
and fail with `invalid MCP server URL`. One command, and the URL is explicit:

```bash
export EVERDICT_API_KEY=ak_…
codex mcp add everdict --url "$EVERDICT_MCP_URL" --bearer-token-env-var EVERDICT_API_KEY
```

Browser OAuth (`codex mcp login everdict`) works only against an **HTTPS** authorization server —
see [Running Codex](https://github.com/everdict/everdict/blob/main/docs/guide/integrations/codex.md#driving-everdict-from-codex).

## What's inside

```
plugin/
├── .claude-plugin/plugin.json   # Claude Code manifest
├── .codex-plugin/
│   ├── plugin.json              # Codex manifest (skills only)
│   └── mcp.json                 # empty — keeps Codex off the ${…} URL below
├── .mcp.json                    # the everdict MCP server (url via ${EVERDICT_MCP_URL})
├── skills/everdict/
│   ├── SKILL.md                 # the flagship context: mental model + entities + workflow
│   └── references/              # domain-model.md · mcp-tools.md · workflows.md (read on demand)
└── commands/
    ├── setup.md                 # /everdict:setup — connect + auth
    └── eval.md                  # /everdict:eval  — guided evaluation of the current project
```
