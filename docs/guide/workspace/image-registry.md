---
kind: wiki
title: "Image registry"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/image-registry/image-registry.routes.ts, packages/contracts/src/infra/image-ref.ts, apps/cli/src/image-push.ts, apps/cli/src/image-bake.ts]
---
# Image registry

Evals run inside images. If an image reference can drift, the eval drifted too — so Everdict wants to
know **which registry an image came from**, and gives your workspace a place to publish its own.

There are two places a workspace publishes to:

- **Everdict's own image store** — a deployment that runs it (the `full` stack's `images` profile) gives
  every workspace a namespace the moment the workspace exists. Nothing to register. **Settings → Images**
  lists what is there.
- **A registry you already own** — GHCR, Harbor, anything that speaks Docker Registry v2, registered by an
  admin under **Settings → Integrations**.

Register one of your own:

```bash
curl -XPUT localhost:8787/workspace/image-registries \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "ghcr",
  "host": "ghcr.io",
  "namespace": "acme",
  "username": "acme-bot",
  "pullSecretName": "GHCR_PULL_TOKEN",
  "pushSecretName": "GHCR_PUSH_TOKEN"
}'
```

The two `*SecretName` fields are *names* of workspace secrets, never the tokens themselves. Check the
connection before you save — the probe takes the same fields and stores nothing:

```bash
curl -XPOST localhost:8787/workspace/image-registries/probe \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d '{"host":"ghcr.io","namespace":"acme","username":"acme-bot","pullSecretName":"GHCR_PULL_TOKEN"}'
```

A workspace can register **several** registries — GHCR for agent images, an internal Harbor for
environment images, whatever matches how your team already works.

## Publish an image you built

```bash
everdict image push my-agent:dev \
  --name my-agent --tag 2026.08.11 \
  --api-url http://localhost:8787 --api-key ak_…
```

The CLI asks the control plane for short-lived push credentials (`images:push`, member and up) — a
scoped grant from Everdict's own store when the deployment runs one, otherwise the push secret of the
registry you name with `--registry <name>` (required only when more than one is registered). It then
`docker tag`s and `docker push`es through a temporary `DOCKER_CONFIG` and prints the fully-qualified
reference to put in a harness or a case. `--register-environment <id>` also registers the pushed ref as
an environment in the same step.

You never copy a registry password into `~/.docker/config.json`, and the mint is recorded — so "who
published the image this eval ran on" has an answer.

## The five classes of image reference

Everdict classifies every image reference it sees, and tells you when one is a liability:

| Class | Example | What it means |
| --- | --- | --- |
| **managed** | `<store-host>/<workspace-namespace>/my-agent:2026.08.11` | in this workspace's namespace of Everdict's own store |
| **workspace** | `ghcr.io/acme/my-agent:2026.08.11` | from a registry this workspace registered — provenance known |
| **external** | `docker.io/library/python:3.12` | a public image — reproducible, but not yours |
| **local** | `localhost:5000/my-agent:dev` | an explicit loopback host — exists only on one machine, will not resolve on a cluster runtime |
| **unqualified** | `my-agent:dev` · `python` | a single-segment name — a local build or a Docker Hub image, and nothing says which |

Registering or validating a harness returns `imageWarnings` for `local` and `unqualified`, and for a
pullable image pinned only by a mutable tag (`mutable-tag`). They are warnings and not errors on
purpose: a `local` image is exactly right while you are iterating on your own runner, and exactly wrong
the moment you ask a cluster to run it.

:::warning
An unqualified or floating tag (`:latest`) makes two scorecards incomparable without anything looking
broken — the harness version is identical, the numbers moved, and nothing recorded that the image
underneath changed. Pin by digest for anything you plan to compare over time.
:::

## Inspecting what is there

```bash
# tags for a repository (add &registry=<name> when several are registered)
curl 'localhost:8787/workspace/image-registries/tags?repository=acme/my-agent' \
  -H 'x-everdict-tenant: default'

# the manifest for one reference — digest, media type, platforms
curl 'localhost:8787/workspace/image-registries/manifest?repository=acme/my-agent&reference=2026.08.11' \
  -H 'x-everdict-tenant: default'

# can this workspace actually pull a full ref? (returns the digest to pin)
curl 'localhost:8787/workspace/image-registries/verify?image=ghcr.io/acme/my-agent:2026.08.11' \
  -H 'x-everdict-tenant: default'
```

The tag listing is what the environment image picker in the capability wizard uses instead of a
free-text box.

## Wrapping a BYO evaluation image

Managed runtimes (Nomad, Kubernetes) run `case.image` **as the task**, which means the image has to
boot the in-job agent itself. If you have an existing benchmark image that does not, wrap it:

```bash
everdict image bake ghcr.io/acme/swebench-env:1.0 --tag ghcr.io/acme/swebench-env:1.0-everdict
everdict image push ghcr.io/acme/swebench-env:1.0-everdict --registry ghcr
```

Then point the case at the baked tag. Nothing about the original image's contents changes; it gains an
entrypoint.

## See also

- [Environments](environments.md) — what these images are for
- [Harness](../concepts/harness.md) — where an image reference gets pinned
- [`../../architecture/workspace-image-registry.md`](../../architecture/workspace-image-registry.md) — the design record
