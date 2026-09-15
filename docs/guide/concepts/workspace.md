---
kind: wiki
title: "Workspace"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/auth/principal.ts, packages/domain/src/auth/authz.ts, packages/domain/src/placement/trust-zone.ts, packages/storage/src/s3-fs.ts, packages/registry/src/versioned-store.ts]
---
# Workspace

A **workspace is a tenant is a trust zone.** Not three ideas that happen to line up — one boundary with
three names. The unit you share work in is the unit you are isolated by.

Every call carries it. On the `dev` profile that is a header:

```bash
curl localhost:8787/me -H 'x-everdict-tenant: default'
```

Anywhere else it comes from your credential:

```bash
curl https://everdict.internal/me -H 'authorization: Bearer ak_…'
```

```json
{ "subject": "user:jimin", "workspace": "acme", "roles": ["member"], "via": "api-key", "…": "…" }
```

That `Principal` is the same object whether it came from an OIDC token (people, through Keycloak), an
API key (`ak_…`, for agents and CI), GitHub Actions federation, or a self-hosted runner's pairing token.
`via` records which. Everything downstream — reads, writes, budget, isolation — is scoped by
`workspace`.

## What the boundary actually enforces

Reads are scoped: no list or get ever crosses tenants. Registry documents are keyed
`(workspace, id, version)`. Secrets are per-workspace, encrypted at rest, injected per run. Cost and run
budgets are tracked per workspace.

Two enforcement points are worth knowing precisely because they are structural rather than careful:

**Isolation** — the trust-zone policy pins a hardened runtime, a namespace, and warm-pool keying per
tenant, so two tenants never share a sandbox.

**Object storage** — the workspace filesystem gives each tenant **its own bucket**, not a prefix inside
a shared one. The bucket *is* the boundary, so a path-traversal bug cannot reach another tenant's data
even if the path guard fails. See [the workspace filesystem](../workspace/filesystem.md).

## Roles are a matrix, not scattered `if`s

Authorization is a role → action matrix. Actions are named pairs:

```
scorecards:read / scorecards:run
issues:read     / issues:write
agents:read     / agents:write
settings:write  ·  images:push
```

A new resource is expected to **reuse** an existing pair rather than invent one — saved Views reuse the
scorecard actions, subscriptions reuse the agent actions. That is why the permission model has stayed
comprehensible while the product grew.

The control plane enforces this. The web app role-gates its UI too, but that is a courtesy; the answer
that matters is the server's.

## `_shared` — the fallback

Documents that belong to no tenant live under the pseudo-workspace `_shared`, and a registry lookup that
misses in your workspace falls back to it. A fresh install registers almost nothing there — only the
first-party agent templates (`scorecard-sentinel`, `failure-fix-pr`), disabled until a workspace adopts
a copy. Reference datasets, harness templates and runtimes under `examples/` are **not** pre-registered;
apply the ones you want into your own workspace.

A workspace can **shadow** a `_shared` id by registering its own document with the same id: your
workspace's document always wins the lookup, and the scorecard records the version that ran.

## Machines are members too

A workspace has human members with roles. It also has [agents](../workspace/agents.md), and an agent
acting inside a workspace acts **for** a member.

That shows up wherever attribution does. A file written to the workspace filesystem records who
published it — member *or* agent, with the agent's id, the conversation, and the member it acted for.
Attribution does not go vague just because a machine did the typing.

## See also

- [Workspace agents](../workspace/agents.md) · [Filesystem](../workspace/filesystem.md)
- [`../../auth.md`](../../auth.md) — OIDC + API keys → `Principal`, the authz matrix
- [`../../tenancy.md`](../../tenancy.md) · [`../../secrets.md`](../../secrets.md)
