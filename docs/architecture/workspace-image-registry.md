# Workspace-scoped image registry — classify + publish harness images

> **Status:** ALL SLICES SHIPPED + LIVE-VERIFIED — S1 registration+classification `bd979a4` ·
> S2 `everdict image push` `921f93a` · S3 web `79ad895` · S4 pull auth at dispatch `9d14595`.
> Live e2e `scripts/live/image-registry-push-pull.mjs` (local authenticated `registry:2`):
> registry registration → `everdict image push` (temp `DOCKER_CONFIG`, user config untouched) →
> unauthenticated pull rejected → `pullWithRegistryAuth` succeeds, sha-identical. SSOT
> for the workspace image registry: where a harness's images *live*, how Everdict tells a
> **local-only** image from a **workspace-registry** image from an **external** one, and how a
> user **publishes** a locally built image to the workspace registry through Everdict. Concretizes
> "Track B — image-source integrations" from `docs/architecture/harness-taxonomy.md`
> (reference-not-build stays true).

## Why

Every image reference in Everdict today is a raw string with no provenance:

- `TopologyService.image` (service harnesses), `EvalCase.image` (portable env contract,
  `docs/architecture/portable-harness-runtime.md`), `CommandHarnessSpec.image` (dispatch image),
  and instance `pins` (slot → image) all hold strings like `spreadsheetbench:v1`,
  `mendhak/http-https-echo:latest`, `localhost:5000/acme/agent:pr-123`.
- Nothing distinguishes a **local daemon build** (`spreadsheetbench:v1` — exists only on the
  machine that built it) from a **Docker Hub** image (`mendhak/http-https-echo:latest`) from a
  **team-managed registry** image. The portability contract ("one definition runs the same
  everywhere") silently breaks when a pin references an image only the author's machine has:
  managed nomad/k8s pulls fail, or a different same-named image runs.
- There is no supported way to *get* a locally built image into a place every runtime can pull
  from. Users side-channel (`docker save`/manual pushes) outside Everdict.

So two features, one axis:

1. **Classification** — given the workspace's registered registry, every image ref is
   deterministically classifiable: `workspace` / `external` / `local` / `unqualified`. Surfaces
   as badges in the web (harness detail), warnings at instance registration, and later as a
   placement input.
2. **Publish** — `everdict image push` takes a local image, gets workspace-scoped push credentials
   from the control plane, and pushes it into the workspace registry — the returned ref is what
   you pin. Building stays on the user's machine (**reference, not build** — no build infra).

## Decisions (locked)

- **Multiple named registries per workspace.** `WorkspaceSettings.imageRegistries[]` is a
  name-keyed roster (upsert by `name`, `DELETE …/:name`). Classification and pull-auth match
  against **all** registered registries (an image is `workspace`-class if it belongs to any);
  push selects one by name (`?name=` / `--registry`, omitted allowed only when exactly one is
  registered — ambiguity is a 400, never a silent pick). The legacy single
  `imageRegistry` field is read as a `name: "default"` entry and cleared on the first write.
  External public images still need no registration to be classified `external`.
- **The registry is BYO** (GHCR, Harbor, a plain `registry:2`, cloud artifact registries…).
  Everdict stores coordinates + SecretStore **name-refs**; it never operates a registry.
- **Secrets are NAME references** (`pullSecretName` / `pushSecretName`), values live in the
  workspace SecretStore — same discipline as `botTokenSecretName` / runtime `authSecret`
  (rule `workspace-integrations`).
- **Classification is pure and lives in `@everdict/core`** (`classifyImageRef`) — no I/O, callers
  pass the workspace registry coordinates. The web mirrors it with a loose client-side copy
  (web is a pure HTTP client; precedent: `harnessInstanceSpecSchema` loose mirror).
- **Push happens on the user's machine, credentials minted by the control plane.** The control
  plane has no Docker; the image exists where it was built. `everdict image push` asks
  `POST /workspace/image-registries/push-credentials[?name=]` for `{name, host, namespace, username, password}`,
  then `docker tag` + `docker push` locally using an **isolated temp `DOCKER_CONFIG`** (never
  touches `~/.docker/config.json`).
- **New authz action `images:push` (member+).** Push-credential minting hands out a credential
  *value* — stronger than any control-plane-mediated action, weaker than `secrets:read`
  (admin: arbitrary secret values). Reusing `harnesses:register` (viewer+) would leak a
  credential to viewers; gating at admin would defeat the point (members author harnesses).
  A dedicated member+ action states the privilege honestly. Registration/removal of the
  registry itself = `settings:write` (admin), like every workspace integration.
- **Reads are viewer+ (`harnesses:read`), not `settings:read`.** The registry view (host,
  namespace, username, secret *names*) is metadata-only and classification is a
  harness-reading concern — every member sees badges. Secret names are already part of the
  member-visible vocabulary (harness env `secretRef`).

## Data model

```ts
// packages/db/src/workspace/workspace-settings.ts — WorkspaceSettingsSchema (JSONB, additive)
imageRegistries: z.array(z.object({
  name: z.string().min(1),               // reference key — push selection points at this
  host: z.string().min(1),               // registry host[:port] — "ghcr.io", "registry.acme.dev:5000"
  namespace: z.string().min(1).optional(), // path prefix under host — "acme" → ghcr.io/acme/<name>:<tag>
  username: z.string().min(1).optional(),  // docker login username (token-only registries omit)
  pullSecretName: z.string().min(1).optional(), // SecretStore name-ref — pull token/password
  pushSecretName: z.string().min(1).optional(), // SecretStore name-ref — push token/password
})).optional(),
// legacy single `imageRegistry` — read as name:"default", cleared on first write
```

No new table, no migration: additive JSONB on `everdict_workspace_settings` + values in
`everdict_secrets` — identical shape to the Mattermost/GHE-App registrations.

## Classification — `classifyImageRef`

`packages/core/src/infra/image-ref.ts`. Follows the Docker reference grammar: the first path
component is a **registry host iff** it contains `.` or `:` or equals `localhost`.

| Class | Meaning | Examples (registry = `ghcr.io/acme`) |
|---|---|---|
| `workspace` | lives in the workspace registry (host **and** namespace prefix match) | `ghcr.io/acme/agent:v3` |
| `external` | explicit foreign host, or `org/name` (implied `docker.io`) | `quay.io/x/y:1`, `mendhak/http-https-echo:latest` |
| `local` | explicit loopback host — only exists where it was built/pushed | `localhost:5000/agent:dev`, `127.0.0.1/x` |
| `unqualified` | bare single-segment name — a local daemon build **or** a Docker Hub library image; syntactically undecidable | `spreadsheetbench:v1`, `postgres:16-alpine` |

`unqualified` is deliberately its own class (not folded into `local`): `postgres:16-alpine`
pulls fine anywhere while `spreadsheetbench:v1` is a local build, and no parser can tell them
apart. The class *names the ambiguity* — the UI nudges toward a fully-qualified ref (push to
the workspace registry, or write `docker.io/library/…`), which is the whole point of the
feature. For placement purposes `local` + `unqualified` are "not guaranteed pullable";
`workspace` + `external` are pullable (given pull auth).

Registration-time surfacing (warn-not-block, like `missingSecrets` on runtime register):
instance/harness registration responses gain `imageWarnings` listing pins whose refs classify
`local`/`unqualified`.

## Surface (BFF↔MCP parity, one service core)

`apps/api/src/integrations/image-registry-service.ts` (`ImageRegistryService`), routes in `server.ts`,
tool twins in `mcp.ts`:

| HTTP | MCP tool | Gate |
|---|---|---|
| `GET /workspace/image-registries` → `{registries}` | `list_workspace_image_registries` | `harnesses:read` (viewer+) |
| `PUT /workspace/image-registries` (name upsert) | `set_workspace_image_registry` | `settings:write` (admin) |
| `DELETE /workspace/image-registries/:name` | `remove_workspace_image_registry` | `settings:write` (admin) |
| `POST /workspace/image-registries/push-credentials?name=` | `get_image_push_credentials` (`registry` arg) | `images:push` (member+) |

- The GET view returns `{host, namespace?, username?, pullSecretName?, pushSecretName?,
  imagePrefix}` — never secret values. `imagePrefix` = `host[/namespace]/` for client-side ref
  building and classification.
- `PUT` verifies referenced secret names exist in the workspace SecretStore (warn field
  `missingSecrets`, not a hard failure — same convention as runtime registration).
- `push-credentials` resolves `pushSecretName` → value from the **workspace** secret tier and
  returns `{host, namespace?, username?, password, imagePrefix}`. Missing registry → 404;
  registry without `pushSecretName` → 400 (push not configured); referenced secret absent → 404 with
  the secret name. The value is returned to the caller and never persisted anywhere else.

## Push flow — `everdict image push`

```
everdict image push spreadsheetbench:v1 [--name spreadsheetbench] [--tag v1] \
  --api-url http://api.everdict.dev --api-key ak_…       (env: EVERDICT_API_URL / EVERDICT_API_KEY)
```

1. `POST /workspace/image-registries/push-credentials?name=` (Bearer = API key → issuer's role; name may be omitted only when there is exactly one registry).
2. Target ref = `host[/namespace]/<name>:<tag>` — `name`/`tag` default from the local ref.
3. `docker tag <local> <target>`.
4. Write `{auths: {host: {auth: base64(user:pass)}}}` to a **temp `DOCKER_CONFIG` dir**,
   `docker --config <dir> push <target>`, delete the dir (`finally`). The user's own
   `~/.docker/config.json` is never read or written.
5. Print the pushed ref — paste it as the pin / service image. (The web register wizard shows
   this command for `local`/`unqualified` refs.)

MCP parity is at the credential level (`get_image_push_credentials`) — an agent with Docker
does the same tag/push mechanics itself. `docker` invocations are the CLI's concern; the
pure helpers (`buildImageTargetRef`, `buildDockerAuthConfig`, local-ref parsing) are exported
and unit-tested.

## Pull wiring (S4 — shipped)

One transient contract, consumed per runtime. `AgentJob.registryAuth` (`RegistryAuthSchema` =
`{host, username?, password}`) follows the `repoToken` discipline exactly: the control plane
resolves `pullSecretName` at dispatch (`executeCase` → `registryAuthFor`, wired for run AND
scorecard), attaches it **only when a job image's explicit host matches the registry host**
(`imageUsesRegistryHost` over `case.image` + service images with per-dispatch `imagePins`
applied), and it is never persisted to any record/dataset.

Consumers (auth is always rendered **only** for host-matching images — no credential spray):

- **Self-hosted runner, `case.image` path:** `runAgentJob` threads `job.registryAuth` into
  `DockerDriver({registryAuth})` → authenticated pre-pull via a temp-`DOCKER_CONFIG`
  (`pullWithRegistryAuth`, 0600, removed in `finally` — the host's `~/.docker/config.json` is
  never touched), then `docker run` uses the local image.
- **Self-hosted runner, service path:** `runLeasedJob` pre-pulls `workspaceImagesToPull(spec,
  imagePins, auth)` before topology deploy — the `TopologyRuntime` interface is unchanged
  (its `docker run` finds the images locally).
- **Nomad (topology + backend):** docker task `Config.auth = [{username, password}]` (HCL block
  in JSON-API array form) — `buildNomadTopologyJob` (via `NomadTopologyRuntimeOptions.registryAuth`)
  and `buildNomadJob` (from `job.registryAuth`).
- **K8s (topology + backend):** a `kubernetes.io/dockerconfigjson` Secret named
  `everdict-registry-auth` (per namespace, idempotent apply) + `imagePullSecrets` on matching pod
  specs — `buildK8sManifests` (via `K8sTopologyRuntimeOptions.registryAuth`) and `buildK8sJob`
  (the backend applies a `List` of Secret+Job).
- **Wiring:** `RuntimeDispatcher.registryAuthFor(tenant)` resolves pull auth when building a
  tenant's topology backend (`buildTopologyBackend({registryAuth})`); baked at first build like
  `secretEnv` (rotation takes effect on backend rebuild/restart — same existing tradeoff).

**Placement gating — deliberately NOT a hard gate.** `local`/`unqualified` images cannot be
*proven* un-pullable: kind's local-registry pattern uses `localhost:5001/...` refs that resolve
in-cluster, and preloaded images (`imagePullPolicy: IfNotPresent`) are a supported managed-runtime
workflow (how the existing examples run). A hard `capability_mismatch` on image class would break
both. The signal stays warn-only: registration/validate `imageWarnings` + web badges. Revisit only
if a real footgun shows up that warnings don't catch.

## Non-goals

- **Building images** — Everdict references images, never builds them (locked in
  `portable-harness-runtime.md`).
- **Operating a registry** — BYO only.
- (retired non-goal) ~~Multiple registries per workspace~~ — shipped: name-keyed roster,
  per-push selection.
- **Rewriting/aliasing image refs at dispatch** — refs stay verbatim in specs; the registry
  informs classification/auth, it does not rewrite pins.

## Slice plan

- **S0 — this doc.**
- **S1 — classify + registration core:** `classifyImageRef` (core) + `WorkspaceSettings.imageRegistry`
  + `ImageRegistryService` + GET/PUT/DELETE routes + MCP twins + `images:push` action +
  registration `imageWarnings`. Tests.
- **S2 — publish:** `POST /workspace/image-registry/push-credentials` + MCP twin + `everdict image
  push` (isolated `DOCKER_CONFIG`, pure helpers tested).
- **S3 — web:** Settings → Integrations "Image registries" card (admin form, Linear settings-list) +
  harness-detail image classification badges (service/command images) + push-command hint in the
  register wizard.
- **S4 — pull auth (shipped):** `AgentJob.registryAuth` transient + DockerDriver/runner pre-pull
  (temp `DOCKER_CONFIG`) + nomad docker `auth` + k8s `dockerconfigjson` Secret/`imagePullSecrets`
  (topology builders AND managed case backends) + dispatch wiring (`executeCase` ·
  `RuntimeDispatcher`). Placement stays warn-only (see the pull-wiring section for why).
