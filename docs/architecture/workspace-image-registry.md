# Workspace-scoped image registry — classify + publish harness images

> **Status:** S0–S3 SHIPPED (S1 registration+classification `bd979a4` · S2 `assay image push`
> `921f93a` · S3 web `79ad895`); S4 (pull auth at dispatch) is the designed follow-up. SSOT for
> the workspace image registry: where a harness's images *live*, how Assay tells a **local-only**
> image from a **workspace-registry** image from an **external** one, and how a user **publishes**
> a locally built image to the workspace registry through Assay. Concretizes "Track B —
> image-source integrations" from `docs/architecture/harness-taxonomy.md` (reference-not-build
> stays true).

## Why

Every image reference in Assay today is a raw string with no provenance:

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
  from. Users side-channel (`docker save`/manual pushes) outside Assay.

So two features, one axis:

1. **Classification** — given the workspace's registered registry, every image ref is
   deterministically classifiable: `workspace` / `external` / `local` / `unqualified`. Surfaces
   as badges in the web (harness detail), warnings at instance registration, and later as a
   placement input.
2. **Publish** — `assay image push` takes a local image, gets workspace-scoped push credentials
   from the control plane, and pushes it into the workspace registry — the returned ref is what
   you pin. Building stays on the user's machine (**reference, not build** — no build infra).

## Decisions (locked)

- **One registry per workspace** (v1). `WorkspaceSettings.imageRegistry` is a single nullable
  object, exactly like `mattermost` (clear = `null`). Multiple registries ("image sources
  roster") is a later generalization if ever needed; external public images need no
  registration to be classified `external`.
- **The registry is BYO** (GHCR, Harbor, a plain `registry:2`, cloud artifact registries…).
  Assay stores coordinates + SecretStore **name-refs**; it never operates a registry.
- **Secrets are NAME references** (`pullSecretName` / `pushSecretName`), values live in the
  workspace SecretStore — same discipline as `botTokenSecretName` / runtime `authSecret`
  (rule `workspace-integrations`).
- **Classification is pure and lives in `@assay/core`** (`classifyImageRef`) — no I/O, callers
  pass the workspace registry coordinates. The web mirrors it with a loose client-side copy
  (web is a pure HTTP client; precedent: `harnessInstanceSpecSchema` loose mirror).
- **Push happens on the user's machine, credentials minted by the control plane.** The control
  plane has no Docker; the image exists where it was built. `assay image push` asks
  `POST /workspace/image-registry/push-credentials` for `{host, namespace, username, password}`,
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
// packages/db/src/workspace-settings.ts — WorkspaceSettingsSchema addition (JSONB, additive)
imageRegistry: z.object({
  host: z.string().min(1),               // registry host[:port] — "ghcr.io", "registry.acme.dev:5000"
  namespace: z.string().min(1).optional(), // path prefix under host — "acme" → ghcr.io/acme/<name>:<tag>
  username: z.string().min(1).optional(),  // docker login username (token-only registries omit)
  pullSecretName: z.string().min(1).optional(), // SecretStore name-ref — pull token/password
  pushSecretName: z.string().min(1).optional(), // SecretStore name-ref — push token/password
}).nullable().optional(),
```

No new table, no migration: additive JSONB on `assay_workspace_settings` + values in
`assay_secrets` — identical shape to the Mattermost/GHE-App registrations.

## Classification — `classifyImageRef`

`packages/core/src/image-ref.ts`. Follows the Docker reference grammar: the first path
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

`apps/api/src/image-registry-service.ts` (`ImageRegistryService`), routes in `server.ts`,
tool twins in `mcp.ts`:

| HTTP | MCP tool | Gate |
|---|---|---|
| `GET /workspace/image-registry` | `get_workspace_image_registry` | `harnesses:read` (viewer+) |
| `PUT /workspace/image-registry` | `set_workspace_image_registry` | `settings:write` (admin) |
| `DELETE /workspace/image-registry` | `remove_workspace_image_registry` | `settings:write` (admin) |
| `POST /workspace/image-registry/push-credentials` | `get_image_push_credentials` | `images:push` (member+) |

- The GET view returns `{host, namespace?, username?, pullSecretName?, pushSecretName?,
  imagePrefix}` — never secret values. `imagePrefix` = `host[/namespace]/` for client-side ref
  building and classification.
- `PUT` verifies referenced secret names exist in the workspace SecretStore (warn field
  `missingSecrets`, not a hard failure — same convention as runtime registration).
- `push-credentials` resolves `pushSecretName` → value from the **workspace** secret tier and
  returns `{host, namespace?, username?, password, imagePrefix}`. Missing registry → 404;
  registry without `pushSecretName` → 400 (푸시 미구성); referenced secret absent → 404 with
  the secret name. The value is returned to the caller and never persisted anywhere else.

## Push flow — `assay image push`

```
assay image push spreadsheetbench:v1 [--name spreadsheetbench] [--tag v1] \
  --api-url http://api.assay.dev --api-key ak_…       (env: ASSAY_API_URL / ASSAY_API_KEY)
```

1. `POST /workspace/image-registry/push-credentials` (Bearer = API key → issuer's role).
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

## Pull wiring (follow-up slices — designed, not yet implemented)

Classification and publish land first; making managed/self-hosted runtimes *authenticate*
pulls from the workspace registry is the follow-up, per runtime:

- **K8s topology/backend:** render a `kubernetes.io/dockerconfigjson` Secret from
  `{host, username, pull value}` + `imagePullSecrets: [{name}]` on pod specs (the
  `imagePullPolicy` knob already exists).
- **Nomad:** docker driver `auth { username, password }` in the task config.
- **Self-hosted runner / DockerDriver:** carry pull auth transiently on the job (like
  `AgentJob.repoToken` — never persisted), runner does an isolated-`DOCKER_CONFIG` pull.
- **Placement:** `local`/`unqualified` images can gate placement the way `case.image`→`docker`
  capability already does (`capability_mismatch` fast-fail instead of a doomed pull).

Until then the existing behavior is unchanged: runtimes pull with host-level credentials.

## Non-goals

- **Building images** — Assay references images, never builds them (locked in
  `portable-harness-runtime.md`).
- **Operating a registry** — BYO only.
- **Multiple registries per workspace** (v1) — single `imageRegistry`; revisit only with a
  concrete need.
- **Rewriting/aliasing image refs at dispatch** — refs stay verbatim in specs; the registry
  informs classification/auth, it does not rewrite pins.

## Slice plan

- **S0 — this doc.**
- **S1 — classify + registration core:** `classifyImageRef` (core) + `WorkspaceSettings.imageRegistry`
  + `ImageRegistryService` + GET/PUT/DELETE routes + MCP twins + `images:push` action +
  registration `imageWarnings`. Tests.
- **S2 — publish:** `POST /workspace/image-registry/push-credentials` + MCP twin + `assay image
  push` (isolated `DOCKER_CONFIG`, pure helpers tested).
- **S3 — web:** Settings → 통합 "이미지 레지스트리" card (admin form, Linear settings-list) +
  harness-detail image classification badges (서비스/커맨드 이미지) + push-command hint in the
  register wizard.
- **S4 — pull auth (follow-up):** k8s `imagePullSecrets` / nomad docker `auth` / runner
  transient pull auth + placement gating, per the section above.
