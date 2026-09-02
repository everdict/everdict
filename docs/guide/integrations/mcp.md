---
kind: wiki
title: "MCP"
status: current
updated: 2026-08-11
---

> Design SSOT: [mcp.md](../../mcp.md) — the maintainer page holds the mechanism. Describe the behaviour here; do not re-derive the design.
# MCP

Everdict speaks MCP so that an agent can drive it the way you would. The endpoint is
`POST /mcp` (Streamable HTTP), and the tools behind it are the same capabilities the HTTP API exposes —
role-gated, workspace-scoped, kept at parity by construction.

That parity is the design commitment: a capability exists on **both** surfaces or neither. There is no
"the UI can do it but the agent cannot".

## Point a client at it

```bash
export EVERDICT_MCP_URL=http://localhost:8787/mcp
export EVERDICT_API_KEY=ak_…
```

Most clients take a JSON block:

```json
{
  "mcpServers": {
    "everdict": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer ak_…" }
    }
  }
}
```

For Claude Code there is a plugin that does this for you plus the domain context —
see [the Claude Code plugin](claude-code-plugin.md).

## Two ways to authenticate

**API key** — for headless clients, CI, and agents. Keys look like `ak_…`, and resolve to the same
`Principal { subject, workspace, roles }` an OIDC token produces:

```bash
curl -XPOST localhost:8787/internal/tenant-keys \
  -H "authorization: Bearer $EVERDICT_INTERNAL_TOKEN" \
  -H 'content-type: application/json' -d '{"workspace":"default"}'
```

**OAuth (Keycloak)** — the "log in like Linear" flow, for a human-attended client. Needs a stack with
Keycloak (`deploy/keycloak/`, or the `full` profile with `--profile auth`).

:::warning
On the `dev` compose profile there is no auth at all — the API accepts an `x-everdict-tenant` header
and everything is workspace `default`. Convenient locally, unusable anywhere else.
:::

## What the agent can actually do

The tool surface follows the product, not a curated subset — evals, the tracker, the workspace, and
the integrations:

| Area | Tools (examples) |
| --- | --- |
| Eval entities | `list_datasets` · `create_dataset` · `register_harness` · `create_judge` · `create_runtime` |
| Running | `run_scorecard` · `get_scorecard` · `diff_scorecards` · `create_schedule` |
| Tracker | `create_issue` · `create_project` · `create_initiative` · `create_cycle` |
| Workspace | `create_agent` · `create_skill` · `create_knowledge_entry` · `create_api_key` · `create_team` |
| Product | `create_product` · `create_release` |

A role gate applies per tool, so an agent holding a `viewer` key can read scorecards and cannot start
one.

## A worked loop

What an agent typically does, in the order it does it:

1. `list_datasets` / `list_harnesses` — find what exists
2. `run_scorecard` — start the batch, get an id back immediately (it is asynchronous)
3. `get_scorecard` — poll until it settles
4. `diff_scorecards` — compare against the baseline
5. `create_issue` — file what regressed, linking the scorecard that proved it

Step 5 is the one people skip and then miss: an issue that cites the scorecard which proved it can
**reopen itself as `regressed`** when that proof stops holding.

## Docs for the agent, not just the human

The published docs site advertises an `llms.txt`, so an agent pointed at the docs URL can read the
domain model before it starts calling tools. Combined with the MCP surface, a fresh session can go from
"no context" to "ran an eval" without a human pasting explanations.

## See also

- [Claude Code plugin](claude-code-plugin.md) — the one-command version of this page
- [Running Codex](codex.md) — Codex as the agent *under test*, which is a different thing
- [`../../mcp.md`](../../mcp.md) — the full tool catalogue and the OAuth flow
