---
kind: wiki
title: "MCP"
status: current
updated: 2026-09-15
anchors: [apps/api/src/mcp.routes.ts, apps/api/src/api/api-key/api-key.routes.ts, apps/api/src/api/ops/internal.routes.ts]
---

> Design SSOT: [mcp.md](../../mcp.md) — the maintainer page holds the mechanism. Describe the behaviour here; do not re-derive the design.
# MCP

Everdict speaks MCP so that an agent can drive it the way you would. The endpoint is
`POST /mcp` (Streamable HTTP), and the tools behind it are the same capabilities the HTTP API exposes —
role-gated, workspace-scoped, kept at parity by construction.

That parity is the design commitment: a capability exists on **both** surfaces or neither. There is no
"the UI can do it but the agent cannot".

## Point a client at it

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
`Principal { subject, workspace, roles }` an OIDC token produces. A member mints a personal key under
**Settings → API keys** (`POST /keys`); it acts with that member's permissions. An operator can mint one
for a workspace with the internal token:

```bash
curl -XPOST localhost:8787/internal/tenant-keys \
  -H "x-internal-token: $EVERDICT_INTERNAL_TOKEN" \
  -H 'content-type: application/json' -d '{"workspace":"default"}'
```

**OAuth (Keycloak)** — the "log in like Linear" flow, for a human-attended client. The control plane
publishes protected-resource metadata at `/.well-known/oauth-protected-resource`. Needs a stack with
Keycloak (`deploy/keycloak/`, or the `full` stack with `--profile auth`).

:::warning
Without `EVERDICT_REQUIRE_AUTH=1` there is no auth at all — the API accepts an `x-everdict-tenant` header
and everything is workspace `default`. That is the `dev` and `prod` Compose default. Convenient locally,
unusable anywhere else.
:::

## What the agent can actually do

The tool surface follows the product, not a curated subset — evals, the tracker, the workspace, and
the integrations:

| Area | Tools (examples) |
| --- | --- |
| Eval entities | `list_datasets` · `create_dataset` · `register_harness` · `create_judge` · `create_runtime` |
| Running | `run_scorecard` · `get_scorecard` · `diff_scorecards` · `create_schedule` |
| Tracker | `create_issue` · `create_project` · `create_initiative` · `add_project_milestone` |
| Workspace | `create_agent` · `create_skill` · `create_knowledge_entry` · `create_api_key` · `create_subscription` · `write_file` |
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

Step 5 is the one people skip and then miss: an issue closed on the scorecard that proved it can
**reopen itself as `regressed`** when that proof stops holding.

## See also

- [Claude Code plugin](claude-code-plugin.md) — the one-command version of this page
- [Running Codex](codex.md) — Codex as the agent *under test*, which is a different thing
- [`../../mcp.md`](../../mcp.md) — the full tool catalogue and the OAuth flow
