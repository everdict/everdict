---
kind: wiki
title: "Connect an agent"
status: current
updated: 2026-08-11
---
# Connect an agent

Everdict exposes the same capabilities twice: an HTTP API for people and scripts, and an **MCP server**
for agents. The two are kept at parity by construction — a tool exists on both surfaces or neither.

The MCP endpoint is `POST /mcp` (Streamable HTTP), role-gated and workspace-scoped exactly like the
HTTP routes.

## The fastest path: the bundled Claude Code plugin

The repository ships a plugin that wires the MCP server, an `everdict` skill, and two slash commands
(`/everdict:setup`, `/everdict:eval`):

```bash
export EVERDICT_MCP_URL=http://<host>:8787/mcp   # put this in your shell profile
```

Then, inside Claude Code:

```
/plugin marketplace add everdict/everdict
/plugin install everdict@everdict
```

From there the agent can register harnesses, submit scorecards, read results, and file issues without
you leaving the session.

## Any other MCP client

Point the client at `POST /mcp`. Authentication comes in two shapes:

- **OAuth (Keycloak)** — the "log in like Linear" flow, for a human-attended client. Requires a stack
  with Keycloak (`deploy/keycloak/`, or the `full` profile's `--profile auth`).
- **API keys** — for headless clients, CI, and agents. Keys look like `ak_…` and are minted from
  `POST /internal/tenant-keys` (which itself needs `EVERDICT_INTERNAL_TOKEN`), or from the account page
  in the web app.

An API key resolves to a `Principal { subject, workspace, roles }` — the same object an OIDC token
produces. Role gating is therefore identical whether a person or an agent is calling.

> On the `dev` compose profile there is no auth at all: the API accepts an `x-everdict-tenant` header
> and the workspace is `default`. Convenient locally, unusable anywhere else.

## From CI

GitHub Actions authenticates **keylessly** through OIDC federation — the workflow's OIDC token is
exchanged for the `ci` role, so there is no long-lived secret in the repository. Three triggers exist:

| Trigger | What it does |
| --- | --- |
| **Pull request** | evaluates with a submit-time ephemeral image swap, recorded in the scorecard's `origin.pinOverrides` |
| **PR comment `/evaluate`** | re-evaluates on demand, gated on the commenter being a collaborator, replying in the thread |
| **Merge** | headless re-pin (`POST /harnesses/:id/pins`) → a new immutable instance version |

`POST /workspace/ci/links/setup-pr` generates the workflow file and opens the pull request that adds it.
Full detail: [`../../architecture/github-actions-trigger.md`](../../architecture/github-actions-trigger.md).

## Run it on your own machine

If the agent must run where your credentials and code already are, register a **self-hosted runner**
instead of a cluster runtime and target it with `runtime: "self:<id>"`:

- **Personal machine** — the desktop app pairs in one click ("Connect this device").
- **Headless / CI box** — `everdict runner --pair rnr_… --api-url <control-plane>`.

The runner leases jobs over MCP and reports results back; your login pays the model cost and a
provenance tag is attached to the run. See
[`../../architecture/self-hosted-runner.md`](../../architecture/self-hosted-runner.md).

## Next

- [`../../mcp.md`](../../mcp.md) — the tool catalogue and the OAuth flow in full
- [`../../api.md`](../../api.md) — the HTTP surface
- [Workspace](../concepts/workspace.md) — what a role can and cannot do
