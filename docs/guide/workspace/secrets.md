# Secrets

Everything that needs a credential — judges calling a provider, a harness pulling a private repo, a
runtime talking to a cluster — reads it from here by **name**. The value is stored encrypted and never
appears in a spec, a scorecard, or a log.

```bash
curl -XPUT localhost:8787/secrets/ANTHROPIC_API_KEY \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d '{"value":"sk-ant-…"}'
```

```bash
curl localhost:8787/secrets -H 'x-everdict-tenant: default'
# → names, who created them, when. Never values.
```

There is no endpoint that returns a secret value. Not for admins, not for you. The only thing that
reads a value is the dispatch path, and it injects it into the job rather than handing it back.

## Names, not values, everywhere else

This is the pattern the whole product follows. A model references its key by name:

```json
{ "id": "sonnet-5", "provider": "anthropic",
  "model": "claude-sonnet-5", "apiKeySecret": "ANTHROPIC_API_KEY" }
```

A runtime references its cluster credential by name:

```json
{ "kind": "nomad", "addr": "https://nomad.internal:4646", "authSecret": "nomad-acl-token" }
```

An image registry, a trace source, a Mattermost bot — all the same. So a spec stays readable and
shareable, and rotating a credential is one `PUT` rather than an edit to every document that uses it.

## Workspace or personal

```bash
# workspace — shared by everyone in it
curl -XPUT localhost:8787/secrets/OPENAI_API_KEY -d '{"value":"sk-…"}'

# personal — yours, on the account page
curl -XPUT 'localhost:8787/secrets/MY_KEY?scope=user' -d '{"value":"sk-…"}'
```

Use workspace scope for anything a scheduled job or a teammate must be able to run. Use personal scope
for a key that is genuinely yours and should leave when you do.

## Two kinds of credential, treated differently

The distinction matters more than it looks:

**Model and provider keys are injected into the job.** The agent needs them to call the model. They
reach the sandbox.

**Cluster credentials are not.** `authSecret` and `kubeconfigSecret` are resolved for the
control-plane→cluster-API call and then **stripped from the job environment**. The untrusted agent
never receives the token that could schedule work on your cluster.

:::warning
That asymmetry is the security model. If you find yourself putting a cluster token where a model key
goes, stop — you are handing the agent under test the ability to launch jobs.
:::

## What "encrypted at rest" requires of you

Set `EVERDICT_SECRETS_KEY` on the control plane. The `full` profile generates one; the `prod` profile
expects it in `deploy/compose/.env`.

Lose that key and the stored values are unrecoverable — which is the point, and also the thing to back
up. Rotating it means re-entering every secret.

## Where a secret is used

```bash
curl 'localhost:8787/secrets/ANTHROPIC_API_KEY/usage' -H 'x-everdict-tenant: default'
```

A reverse index answers "what breaks if I delete this" before you delete it, rather than after. Judges,
models, harnesses, runtimes and integrations all report their references.

## Offline tokens

```bash
curl -XPOST localhost:8787/secrets/MY_TOKEN/offline-token \
  -H 'content-type: application/json' -d '{}'
```

For a credential that must be handed to a long-running process which cannot come back and ask again —
a self-hosted runner, an agent turn with no request behind it. Short-lived, scoped, and recorded.

## Habits worth having

- **Name them after what they are, not where they came from.** `ANTHROPIC_API_KEY` outlives
  `jimins-key-2`.
- **Check `usage` before deleting.** A judge whose key vanished produces `unmeasured` scores with
  reason `missing_secret` — recoverable, but only after someone notices.
- **Personal keys do not survive you.** A schedule that depends on one stops working when you leave.

## See also

- [Workspace](../concepts/workspace.md) — the boundary secrets are scoped to
- [Runtime](../concepts/runtime.md) — how cluster credentials are used and stripped
- [`../../secrets.md`](../../secrets.md) · [`../../models.md`](../../models.md)
