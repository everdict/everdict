---
kind: wiki
title: "Secrets"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/secret/secret.routes.ts, apps/api/src/api/secret/request/secret-name.ts, packages/contracts/src/records/secret.ts]
---
# Secrets

Everything that needs a credential — judges calling a provider, a harness pulling a private repo, a
runtime talking to a cluster — reads it from here by **name**. The value is stored encrypted and never
appears in a spec, a scorecard, or a log.

A name is environment-variable shaped (`^[A-Z_][A-Z0-9_]*$`), because that is how it reaches a job.

```bash
curl -XPUT localhost:8787/secrets/ANTHROPIC_API_KEY \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d '{"value":"sk-ant-…"}'
```

```bash
curl localhost:8787/secrets -H 'x-everdict-tenant: default'
# → names and scopes. Never values.
```

No endpoint reads a secret back by name. Not for admins, not for you. A value leaves the store only to be
used: injected into a job at dispatch, or minted as short-lived push credentials for
`everdict image push`.

## Names, not values, everywhere else

This is the pattern the whole product follows. A model references its key by name:

```json
{ "id": "sonnet-5", "provider": "anthropic",
  "model": "claude-sonnet-5", "apiKeySecret": "ANTHROPIC_API_KEY" }
```

A runtime references its cluster credential by name (excerpt):

```json
{ "kind": "nomad", "addr": "https://nomad.internal:4646", "authSecret": "NOMAD_ACL_TOKEN" }
```

An image registry, a trace source, a Mattermost bot — all the same. So a spec stays readable and
shareable, and rotating a credential is one `PUT` rather than an edit to every document that uses it.

## Workspace or personal

```bash
# workspace — shared by everyone in it (admin)
curl -XPUT localhost:8787/secrets/OPENAI_API_KEY -H 'content-type: application/json' \
  -d '{"value":"sk-…"}'

# personal — yours alone (Settings → Personal secrets)
curl -XPUT localhost:8787/secrets/MY_KEY -H 'content-type: application/json' \
  -d '{"value":"sk-…","scope":"user"}'
```

Use workspace scope (**Settings → Secrets**) for anything a scheduled job or a teammate must be able to
run. Use personal scope for a key that is genuinely yours and should leave when you do.

## Two kinds of credential, treated differently

The distinction matters more than it looks:

**Model and provider keys are injected into the job.** The agent needs them to call the model. They
reach the sandbox.

**Cluster credentials are not.** `authSecret` and `kubeconfigSecret` are resolved for the
control-plane→cluster-API call and **never placed in the job environment**. The untrusted agent never
receives the token that could schedule work on your cluster.

:::warning
That asymmetry is the security model. If you find yourself putting a cluster token where a model key
goes, stop — you are handing the agent under test the ability to launch jobs.
:::

## What "encrypted at rest" requires of you

Set `EVERDICT_SECRETS_KEY` (base64, 32 bytes) on the control plane. The `full` stack's `full.sh`
generates one; the `prod` stack expects it in `deploy/compose/.env`. Unset, the control plane generates an
ephemeral key at boot — fine in memory, and fatal for a persistent database, because the next restart
cannot decrypt what the last one stored.

Lose that key and the stored values are unrecoverable — which is the point, and also the thing to back
up. Rotating it means re-entering every secret.

## Where a secret is used

```bash
curl localhost:8787/secrets/usage -H 'x-everdict-tenant: default'
```

A reverse index (admin-only) answers "what breaks if I delete this" before you delete it, rather than
after: every workspace secret with the harnesses, runtimes, models and integrations that reference it.
A secret referenced nowhere comes back with no references.

## Offline tokens

```bash
curl -XPUT localhost:8787/secrets/GRAFANA_TOKEN/offline-token \
  -H 'content-type: application/json' -d '{
  "grant": { "tokenUrl": "https://sso.internal/oauth/token", "clientId": "everdict",
             "refreshToken": "…" }
}'
```

For a service that issues short-lived OAuth access tokens. The secret stores the long-lived refresh
token; the grant is validated when you save it, and every later use of the name injects a freshly minted
access token. The tokens themselves are never returned.

## Habits worth having

- **Name them after what they are, not where they came from.** `ANTHROPIC_API_KEY` outlives
  `JIMINS_KEY_2`.
- **Check `usage` before deleting.** A judge whose key vanished produces `unmeasured` scores with
  reason `missing_secret` — recoverable, but only after someone notices.
- **Personal keys do not survive you.** A schedule that depends on one stops working when you leave.

## See also

- [Workspace](../concepts/workspace.md) — the boundary secrets are scoped to
- [Runtime](../concepts/runtime.md) — how cluster credentials are used
- [`../../secrets.md`](../../secrets.md) · [`../../models.md`](../../models.md)
