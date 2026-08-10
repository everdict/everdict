# Workspace

A **workspace is a tenant is a trust zone.** Everdict does not treat these as three ideas that happen
to line up — they are one boundary with three names, and collapsing them is deliberate: the unit you
share work in is the unit you are isolated by.

Everything else in the product is scoped to a workspace: harnesses, datasets, judges, runtimes,
secrets, scorecards, issues, files.

## What the boundary actually enforces

| Layer | What the workspace decides |
| --- | --- |
| **Reads** | every list and get is workspace-scoped; a principal never sees another tenant's records |
| **Registry** | documents are keyed `(workspace, id, version)`, with a `_shared` fallback for seeded content |
| **Secrets** | model and provider keys are per-workspace, encrypted at rest, injected per-run |
| **Isolation** | the trust-zone policy pins a hardened runtime, a namespace, and warm-pool keying per tenant |
| **Budget** | cost and run budgets are tracked per workspace |
| **Object storage** | the workspace filesystem gives each tenant **its own bucket** — the bucket *is* the isolation boundary |

## Who is inside it

Authentication resolves to a `Principal { subject, workspace, roles, via }` — whether it came from an
OIDC token (Keycloak, for people) or an API key `ak_…` (for agents, CI, and headless clients). The
`via` field records which one.

Authorization is a **role → action matrix**, not a scattering of `if` statements. Actions are named
pairs (`scorecards:read` / `scorecards:run`, `issues:read` / `issues:write`, `settings:write`, …), and
a new resource is expected to reuse an existing pair rather than invent one — saved Views reuse the
scorecard actions; subscriptions reuse the agent actions.

The control plane enforces this. The web app role-gates its UI too, but that is a courtesy: the answer
that matters is the server's.

## `_shared` — the seeded fallback

Some content ships with the product rather than belonging to a tenant: reference datasets, example
harness templates, first-party judges. Those live under the pseudo-workspace `_shared`, and a lookup
that misses in your workspace falls back to it.

Two consequences worth knowing:

- A workspace can **shadow** a `_shared` id by registering its own document with the same id. That is
  intended, and the resolution is recorded so a result can always be traced to the document that
  actually produced it.
- `_shared` writes never emit platform events — boot seeding is not workspace news.

## Members, and the machines acting for them

A workspace has human members with roles. It also has **agents**, and an agent acting inside a
workspace acts *for* a member: writes to the workspace filesystem record who published them — member
**or** agent (agent id + conversation + the member it acted for). Attribution does not become vague
just because a machine did the typing.

## Where this shows up next

- [`../../auth.md`](../../auth.md) — the auth core: OIDC + API keys → `Principal`, the authz matrix
- [`../../tenancy.md`](../../tenancy.md) — the tenant access layer and scoped reads
- [`../../secrets.md`](../../secrets.md) — workspace secrets and per-run injection
- [`../../architecture/workspace-filesystem.md`](../../architecture/workspace-filesystem.md) — one file tree per workspace
