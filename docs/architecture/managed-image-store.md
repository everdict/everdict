# The managed image store

> **Status:** DESIGN — direction confirmed with the maintainer (2026-07-29): Everdict should OWN the
> image interface the way it owns the workspace filesystem, so self-hosters plug an adapter instead of
> bringing a registry. Supersedes the BYO-only model of `docs/architecture/workspace-image-registry.md`
> (which becomes ONE adapter under this port) and completes
> `docs/architecture/environment-image-store.md` (the entity this serves).

## Why

An environment image is already a **composite entity**: bytes plus the agent-facing context that makes
it usable (`contents`, `preset`, `instructions`, benchmark, provenance). Today those two halves have
two different owners — the bytes live in a registry the tenant brought, the context lives in our
capability record — and we suture them after the fact with `ImageRegistryService.verifyImage`. Every
consequence of that split is a symptom, not a design:

- **Onboarding asymmetry.** A workspace gets a filesystem the moment it exists; it gets an image
  registry only after an admin registers a host and two SecretStore refs. With no registry there is no
  publish path at all — the authoring half of the environment store is gated behind BYO infrastructure.
- **We can only ask, never guarantee.** `probe` and `verifyImage` exist because the registry is
  someone else's: we have to interrogate it to find out whether the thing we just told the user about
  actually works. `classifyImageRef` warns instead of knowing.
- **Sharing stops at the asset.** The store shares the *ref*, not the *bytes* — a public OfficeQA
  environment is unusable by a consumer who cannot authenticate to the publisher's private registry
  (`verify.reason === "auth"` is exactly that dead end). Cross-tenant credential brokering is
  impossible against a registry we do not control.
- **One credential per job.** `CaseJob.registryAuth` is singular because BYO credentials are per-host
  and unmergeable; a topology pulling from two BYO registries authenticates only the first match.

Owning the interface removes the suture. The same argument that made the filesystem ours applies with
more force here, because the entity does not exist in the OCI world at all — no registry stores a
topology preset or agent instructions, so a registry can never be the SSOT for what we are actually
publishing.

## Decision — a `WorkspaceImages` port, managed by default

`packages/application-control/src/ports/workspace-images.ts`, in the exact idiom of `WorkspaceFs`:
tenant FIRST on every method, isolation enforced INSIDE the adapter, never by caller discipline.

```
listRepositories(tenant)                → ImageRepo[]
listTags(tenant, repository)            → string[]
inspect(tenant, repository, reference)  → ImageManifestInfo
mintPushGrant(tenant, repository)       → ImageGrant   // short-lived, scoped to that one repo
mintPullGrant(tenant, refs[])           → ImageGrant[] // MANY repo scopes, one grant per endpoint
remove(tenant, repository, reference?)  → number
usage(tenant)                           → { bytes, repositories }
```

The existing `RegistryReader` port is not retired — it becomes the read adapter *underneath* this port
(the BYO adapter and the managed adapter both speak Docker Registry v2 over it).

## Isolation — the boundary moves from the bucket to the token

The filesystem's boundary is the bucket: `fsBucketFor(prefix, tenant)` =
`<prefix>-<sanitized>-<sha256:8>`, one per tenant, created lazily. A registry cannot copy that, because
a registry process must serve every repository it hosts — a bucket per tenant would mean a registry per
tenant, which is absurd operationally. So the boundary moves one layer up, and **we become the
authorization server**:

- **Namespace** — `imageRepoFor(tenant)` = `<sanitized>-<sha256:8>` (the same collision-proof rule as
  `fsBucketFor`, for the same reason: a sanitization collision between `"Acme"` and `"acme"` would be
  cross-tenant leakage). A tenant's images live at `<endpoint>/<namespace>/<name>:<tag>`.
- **Token** — the registry is configured for Docker Registry v2 token auth (`auth.token` with
  `realm` pointing at the control plane). It holds **no** user database; it validates an RS256 JWT
  signed by us and honors exactly the scopes that token carries. A token scoped to another tenant's
  namespace cannot be minted, so it cannot exist.

The invariant that matters is preserved verbatim — *isolation lives inside the adapter, not in caller
discipline* — only its enforcement point changes from storage to signature. This asymmetry with the
filesystem is deliberate and must stay documented: nobody should later "fix" it by reaching for a
bucket per tenant.

## Adapters

| Adapter | Backing | Role |
| --- | --- | --- |
| `ManagedImageStore` | bundled CNCF `distribution` (`registry:2`) + our token server | The default. Storage driver `s3` against the MinIO that already backs the filesystem and the artifact store (`EVERDICT_S3_*`), or driver `filesystem` for a self-hoster with their own volume — the same "swap the adapter to fit your infra" story as `S3WorkspaceFs` vs `InMemoryWorkspaceFs`. |
| `ByoImageStore` | the tenant's own registry (`WorkspaceSettings.imageRegistries[]`) | Today's model, demoted from *the* model to *an* adapter. Kept because an enterprise with a mandated Harbor/ECR must not be forced to duplicate images into ours. `probe` / `verifyImage` / push-credential minting stay here — they are BYO concerns. |
| `InMemoryImageStore` | in-process map | dev/test, mirrors the semantics exactly. |

Deployment constraints worth stating up front, because they bite in self-hosted compose:

- The registry endpoint must be reachable **from every execution node** — including a self-hosted
  runner on a user's laptop. Same class of problem as `CONTROL_PLANE_WS_URL`; the managed endpoint is
  an operator-configured public URL, not a container-network name.
- Docker refuses plain HTTP for anything but loopback. The bundled compose stack terminates TLS in
  front of the registry, or the operator adds it to `insecure-registries` (documented, not silent).

## What the ownership buys

1. **Onboarding drops to zero** — a workspace has a place to publish images the moment it exists,
   exactly like its file tree.
2. **The singular-credential limitation dissolves** — one grant can carry many repository scopes, so a
   multi-service topology pulling three managed images authenticates all three. `CaseJob.registryAuth`
   becomes `registryAuths[]`.
3. **Cross-tenant pull becomes real sharing** (see below).
4. **Provenance is minted, not scraped** — the digest comes from the registry's own response to our
   push grant, so `everdict image push --register-environment` stops parsing `docker image inspect`
   `RepoDigests` and the capability record's `image` is authoritative by construction.
5. **`probe` / `verifyImage` become BYO-only** — for a managed image, "can this workspace pull it" is
   answered by policy, not by an HTTP round trip that might lie a second later.
6. **Quota, GC and lifecycle are ours** — `usage(tenant)` feeds the existing usage metering the same
   way filesystem usage does, and retention becomes a policy we can state instead of a registry we hope
   was cleaned up.

## Cross-tenant pull — bytes, not just the asset

The store's four reach tiers already decide *who may consume* a capability; the pure kernel
`canConsumeCapability` is the judge. With the registry under our authorization server, that decision
extends from metadata to bytes with no new policy surface:

```
mintPullGrant(consumerTenant, ["<publisher-ns>/officeqa-env@sha256:…"])
  → resolve ref → owning namespace → owning tenant
  → the environment capability that declares this ref
  → canConsumeCapability(capability, consumerTenant) ? add scope "repository:<publisher-ns>/officeqa-env:pull" : omit
```

A consumer that adopted a `public` environment pulls it directly — no publisher credential is ever
handed over, no bytes are copied between tenants, and revoking reach revokes pull on the next grant
(grants are short-lived by construction). This closes the `environment-image-store.md` non-goal
"cross-tenant pull-credential brokering" and makes `adopt` mean what users already read it as: *this
environment is usable here*.

Boundary: the scope is granted **only for a ref a consumable capability declares**. Pointing a pull
grant at an arbitrary repository in someone else's namespace is not a request we can satisfy, ever.

## Contract changes

- `CaseJob.registryAuth: RegistryAuth` → `registryAuths: RegistryAuth[]` — the wire codec and every
  consumer (DockerDriver pre-pull, self-hosted runner pre-pull, Nomad `Config.auth`, the K8s
  dockerconfigjson Secret, both topology builders) render all matching entries instead of the first.
  Each consumer already filters by `imageUsesRegistryHost`; the change is fan-out, not new logic.
  The singular field is **kept and dual-written**, not deleted: a self-hosted runner is user-installed
  and can lag the control plane, it reads only that field, and dropping it would silently
  un-authenticate an older runner's pulls (a failure that looks like a broken registry, not like a
  version skew). Every consumer reads through `registryAuthsOf`, which prefers the plural, so the
  compatibility lives in one function and the field can be deleted once runners have rolled.
- `classifyImageRef` gains a **`managed`** class ahead of `workspace`: a ref inside the tenant's own
  managed namespace is not merely "a registry you registered", it is ours — the web renders it as the
  provenance-clean case and harness validation stops warning about it.
- `ImageGrant` (new wire type): `{ endpoint, repositories[], token, expiresAt }`. Transient like
  `repoToken` — never persisted, never logged, stripped from allocation env.
- `WorkspaceSettings.imageRegistries[]` is untouched; it is now the `ByoImageStore` adapter's config.

## Surfaces

| Surface | What |
| --- | --- |
| HTTP (`apps/api` `api/images/`) | `GET /workspace/images` (repositories + usage) · `GET /workspace/images/:repo/tags` · `POST /workspace/images/push-grant` (`images:push`) · `DELETE /workspace/images/:repo` · `GET /v2/token` (the registry's auth realm — unauthenticated by Fastify's normal chain, it authenticates the docker client's basic credentials itself) |
| MCP (parity) | `list_workspace_images` · `list_image_tags` (managed-aware) · `inspect_image` · `push_image_grant` |
| CLI | `everdict image push <ref>` mints a push grant instead of push credentials; `--register-environment <id>` registers with the registry-reported digest in the same call |
| Web | Settings › Images — managed repositories (tags, size, last push, delete) as the primary panel, BYO registries demoted to a secondary "external registries" section |
| Agent | unchanged tool names; the system prompt's authoring recipe loses the "register a registry first" precondition |

## Slices

- **M1 — port + contracts.** `WorkspaceImages` port, `ImageGrant`/`ImageRepo` wire types,
  `imageRepoFor` + `classifyImageRef` `managed` class in `@everdict/domain`, `registryAuths[]` on
  `CaseJob` with every consumer fanned out. No behavior change yet (managed store absent = today).
- **M2 — `ManagedImageStore`.** ✅ New `packages/images` (a registry client is not object storage, so it
  does not belong in `@everdict/storage`): `RegistryTokenIssuer` (the authorization server: grant →
  scoped registry token), `ManagedRegistryApi` (catalog/tags/manifest/delete as the namespace OWNER —
  distinct from the `RegistryReader` port, which is the BYO guest path), `ManagedImageStore` and
  `InMemoryImageStore`. Two token audiences, deliberately: a **grant** is what a client presents as its
  registry password, and only the token endpoint can exchange it for a **registry token**, so a grant
  cannot be replayed at the registry. `narrowAccess` makes the exchange able to narrow a grant and never
  widen it. Cross-tenant refs are omitted from a pull grant with a comment pointing at M6 — the safe
  default is the registry's own 401, never authorization we invented.
- **M3 — the token server.** ✅ `GET /v2/token` in `apps/api` (outside the Principal chain: the caller is a
  docker client that has never heard of our Bearer tokens, and the grant it presents IS the permission),
  `registry:2` behind the `images` compose profile with the S3 driver on the existing MinIO, key/cert
  generated by `full.sh` into a gitignored `certs/` and mounted as files — never env values, because a
  PEM in the environment leaks into every child process. The served `imageClasses` can now say
  `managed`, so the web's zod mirrors and labels landed with it. **Verified live**
  (`scripts/live/managed-image-store.mjs`): a real distribution registry accepts our `x5c` tokens, a
  grant pushes and pulls, and a grant for one namespace is refused at another — the isolation claim
  checked against the actual enforcement point rather than our own assertion about it.
  - **The realm is resolved by the docker CLIENT, not by the registry** — the registry only advertises
    it in its 401 challenge. A container-network name there fails on every client; the live run proved
    it by failing that way first. Same class of setting as `CONTROL_PLANE_WS_URL`, and the reason
    `IMAGE_STORE_ENDPOINT`/`IMAGE_STORE_REALM` are surfaced in `full.sh`'s output with a warning
    instead of buried in compose.
  - The exchange logic lives in `@everdict/images` (`ImageTokenService`), not in `apps/api/core`:
    nothing in it knows about HTTP frameworks, and keeping it beside the issuer is what lets the live
    check exercise the real code path instead of a re-implementation of it.
- **M4 — dispatch.** ✅ `buildImagePullAuths` is the ONE answer to "what does this job need to pull its
  images" — managed grants first (consumers take the first host match, and ours is the credential we can
  vouch for), BYO second; `executeCase` and the `RuntimeDispatcher` both call it, so run, scorecard and
  topology authorize identically. The seam became **image-scoped** (`(workspace, images)`): a managed
  grant is minted for the repositories in flight, and a resolver that answered "here is every credential
  the tenant has" would defeat the point of scoping one. Both halves stay best-effort — an unreachable
  registry must not fail a job whose other images pull fine (the warn-only placement stance).
  - **Grants outlive the queue.** Credentials are minted BEFORE a job is scheduled, so the lifetime has
    to cover queue wait + pull, not just the token exchange:
    `EVERDICT_IMAGE_STORE_GRANT_TTL_SECONDS` defaults to an hour. Lower it to tighten how fast revoked
    reach stops working; a job queued past it fails at pull with the registry's own error, which is
    visible rather than silent.
- **M5 — publish.** CLI push over a grant; atomic `--register-environment` with the minted digest.
- **M6 — cross-tenant pull.** Scope authorization over `canConsumeCapability`; `adopt` verification
  becomes a policy answer for managed refs and keeps the HTTP check for BYO refs.
- **M7 — web.** Settings › Images; BYO demoted; managed badges in the harness/environment surfaces.
- **M8 — docs + skills.** Rewrite `workspace-image-registry.md` as the BYO adapter chapter, close the
  `environment-image-store.md` non-goal, update the plugin skill + agent system prompt recipe.

## Non-goals

- **Building images.** Unchanged: `docker build` stays the author's. We store, authorize, describe.
- **Being a general-purpose container registry.** The managed store serves eval assets (environments,
  harness images). It is not a place to host a tenant's production images.
- **Pull-through caching of external base images.** Attractive later (offline evals, rate limits), out
  of scope now.
- **AWS ECR SigV4 in the BYO adapter.** Still out of scope, unchanged.
- **Image signing (cosign/notation).** The trust story stops at our token server in v1.

## Open questions

- **Retention policy.** Untagged manifests accumulate; `distribution`'s GC needs a read-only pause.
  Scheduled per-deployment maintenance, or per-tenant tag-count caps?
- **SaaS multi-region.** One registry per deployment is fine self-hosted; a hosted Everdict eventually
  wants regional endpoints, which makes the grant's `endpoint` tenant-resolved rather than global.
- **Does the managed store subsume `_everdict` first-party environments?** Seeding common benchmark
  images into our own namespace is now possible — is that a tier of the store or a separate operator
  workflow?
