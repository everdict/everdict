# Image registry

Evals run inside images. If an image reference can drift, the eval drifted too — so Everdict wants to
know **which registry an image came from**, and gives your workspace a place to publish its own.

Register a registry you already own:

```bash
curl -XPUT localhost:8787/workspace/image-registries \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "ghcr",
  "host": "ghcr.io",
  "namespace": "acme",
  "authSecret": "ghcr-token"
}'
```

`authSecret` is the *name* of a workspace secret, never the token itself. Check it works before you
depend on it:

```bash
curl -XPOST 'localhost:8787/workspace/image-registries/probe' \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d '{"name":"ghcr"}'
```

A workspace can register **several** registries — GHCR for agent images, an internal Harbor for
environment images, whatever matches how your team already works.

## Publish an image you built

```bash
everdict image push my-agent:dev \
  --registry ghcr --name my-agent --tag 2026.08.11 \
  --api-url http://localhost:8787 --api-key ak_…
```

The CLI mints short-lived push credentials from the control plane (`images:push`, member-gated),
`docker tag`s and `docker push`es, and hands back the fully-qualified reference to put in a harness or
a case.

You never copy a registry password onto a laptop, and the mint is recorded — so "who published the
image this eval ran on" has an answer.

## The four classes of image reference

Everdict classifies every image reference it sees, and tells you when one is a liability:

| Class | Example | What it means |
| --- | --- | --- |
| **workspace** | `ghcr.io/acme/my-agent:2026.08.11` | from a registry this workspace registered — provenance known |
| **external** | `docker.io/library/python:3.12` | a public image — reproducible, but not yours |
| **local** | `my-agent:dev` | exists only on one machine — will not resolve on a cluster runtime |
| **unqualified** | `python` | no host, no tag — resolves to something different depending on where it runs |

Registering or validating a harness returns `imageWarnings` for the last two. They are warnings and not
errors on purpose: a `local` image is exactly right while you are iterating on your own runner, and
exactly wrong the moment you ask a cluster to run it.

:::warning
An unqualified or floating tag (`:latest`) makes two scorecards incomparable without anything looking
broken — the harness version is identical, the numbers moved, and nothing recorded that the image
underneath changed. Pin by digest for anything you plan to compare over time.
:::

## Inspecting what is there

```bash
# tags for a repository
curl 'localhost:8787/workspace/image-registries/tags?repository=acme/my-agent' \
  -H 'x-everdict-tenant: default'

# the manifest for one reference
curl 'localhost:8787/workspace/image-registries/manifest?repository=acme/my-agent&reference=2026.08.11' \
  -H 'x-everdict-tenant: default'
```

This is what the harness authoring UI uses to offer a tag picker instead of a free-text box.

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
