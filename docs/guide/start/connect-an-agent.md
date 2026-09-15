---
kind: wiki
title: "Connect an agent"
status: current
updated: 2026-09-15
anchors: [apps/api/src/mcp.routes.ts, apps/api/src/api/api-key/api-key.routes.ts, packages/auth/src/github-actions.ts, apps/cli/src/runner-command.ts, plugin/.mcp.json]
---
# Connect an agent

Everdict exposes its capabilities twice: an HTTP API for people and scripts, and an **MCP server**
for agents. Each API resource registers its HTTP routes and its MCP tools side by side over the same
service.

The MCP endpoint is `POST /mcp` (Streamable HTTP), role-gated and workspace-scoped exactly like the
HTTP routes. It always requires a Bearer credential.

The web app's **Connect** pages (`/<workspace>/connect/claude-code`, `/connect/codex`,
`/connect/desktop`) show the snippets below with your control plane's URL filled in.

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
- **API keys** — for headless clients, CI, and agents. Keys look like `ak_…`. Mint your own in the web
  app under **Settings › API keys** (`POST /keys`; a key acts with your permissions), or, as an operator,
  mint one for a workspace with `POST /internal/tenant-keys` and the `x-internal-token` header
  (`EVERDICT_INTERNAL_TOKEN`).

An API key resolves to a `Principal { subject, workspace, roles, via }` — the same object an OIDC token
produces. Role gating is therefore identical whether a person or an agent is calling.

> On the `dev` compose profile the HTTP routes need no auth: they accept an `x-everdict-tenant` header
> and the workspace is `default`. `/mcp` still wants a Bearer — mint a key under Settings › API keys.
> Convenient locally, unusable anywhere else.

## From CI

GitHub Actions authenticates **keylessly** through OIDC federation — the workflow's OIDC token is
exchanged for the `ci` role, trusted only for repositories linked in the workspace's CI settings, so
there is no long-lived secret in the repository. Three triggers exist:

| Trigger | What it does |
| --- | --- |
| **Pull request** | evaluates with a submit-time ephemeral image swap, recorded in the scorecard's `origin.pinOverrides` |
| **PR comment `/evaluate`** | re-evaluates on demand, gated on the commenter being a collaborator, replying in the thread |
| **Merge** | headless re-pin (`POST /harnesses/:id/pins`) → a new immutable instance version |

`POST /workspace/ci/links/setup-pr` generates the workflow file and opens the pull request that adds it.
A CI link cannot target a personal runner; by default its evaluations go to the workspace-shared runner
pool (`self:ws`), and setup refuses to open the pull request while that pool is empty.
Full detail: [`../../architecture/github-actions-trigger.md`](../../architecture/github-actions-trigger.md).

## Run it on your own machine

If the agent must run where your credentials and code already are, register a **self-hosted runner**
instead of a cluster runtime and target it with `runtime: "self:<runner-id>"`:

- **Personal machine** — the desktop app pairs in one click ("Connect this device as a runner").
- **Headless / CI box** — pair it from the web app's **Runtimes** page (or `POST /runners`), then
  `everdict runner --pair rnr_… --api-url <control-plane>`.

The runner leases jobs over MCP and reports results back; your login pays the model cost and a
provenance tag is attached to the run. See
[`../../architecture/self-hosted-runner.md`](../../architecture/self-hosted-runner.md).

## Next

- [`../../mcp.md`](../../mcp.md) — the tool catalogue and the OAuth flow in full
- [`../../api.md`](../../api.md) — the HTTP surface
- [Workspace](../concepts/workspace.md) — what a role can and cannot do
