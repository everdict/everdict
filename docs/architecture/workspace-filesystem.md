# The workspace filesystem

> One isolated file tree per workspace, shared by every surface: agents persist task outputs as real
> files, skill/knowledge bodies live on it, and the web browses it like a shell. Backed by object
> storage (S3/MinIO — distributed by construction) or memory (dev).

## Why

Agent work products used to evaporate with the conversation (chat text, session-scoped artifacts).
Skills already smuggled a proto-filesystem into a jsonb column (`files[{path,content}]`), knowledge
bodies lived only in rows, and nothing gave the workspace a durable, browsable place where "the
agent wrote me a report" produces an actual file. The workspace filesystem makes that place
first-class — with the same tenancy guarantee as every other store: **a workspace can never see
another workspace's tree.**

## The port and its implementations

`WorkspaceFs` (port, `@everdict/application-control` `ports/workspace-fs.ts` — impls in `@everdict/storage`):

```
list(tenant, dir)      → FsEntry[]          // immediate children; dirs first, name-sorted
stat(tenant, path)     → FsEntry | undefined
read(tenant, path)     → { entry, data } | undefined
write(tenant, path, data, contentType?) → FsEntry   // create-or-replace; parents implicit; 5 MiB cap
mkdir(tenant, path)    → FsEntry            // idempotent (mkdir -p); marker object keeps empty dirs
remove(tenant, path, {recursive?}) → number // objects removed; non-empty dir demands recursive
move(tenant, from, to) → FsEntry            // file rename or whole-subtree move; no overwrite
```

- **Isolation lives INSIDE the adapters, never in caller discipline.** Every operation funnels
  through `normalizeFsPath` (`@everdict/contracts` `records/workspace-file.ts`) — traversal (`..`)
  and unsafe characters are rejected, paths canonicalize to `"" | "a/b/c"` — and the tenant slug
  (same strict charset) selects the tenant's own storage namespace.
- **S3WorkspaceFs** — the distributed backend, **one MinIO/S3 bucket per tenant**: the bucket IS the
  isolation boundary (per-tenant credentials, quotas and lifecycle policies attach at the storage
  layer; dropping a workspace's data = dropping its bucket). Bucket names come from `fsBucketFor` —
  `<prefix>-<sanitized-tenant>-<sha256:8>` (default prefix `everdict-fs`, override
  `EVERDICT_S3_FS_BUCKET_PREFIX`): the readable head is for operators, the hash tail guarantees
  distinct tenants ("Acme" vs "acme", "a.b" vs "a-b") never collide onto one bucket. Buckets are
  created lazily on a tenant's first touch (HeadBucket → CreateBucket, per-process cached). Inside a
  bucket, keys ARE the canonical paths (empty-dir markers `<dir>/`). Same `EVERDICT_S3_*`
  endpoint/credentials as the artifact store; SDK failures remap to `UpstreamError`.
- **InMemoryWorkspaceFs** — dev/test, mirrors the exact semantics (per-process, not persisted).
- The file/dir axis stays consistent everywhere: no file over a dir, no children under a file —
  every surface can render one coherent tree.
- Distinct from `ArtifactStore` (write-only blob offload → presigned ref): the filesystem is a
  READ/WRITE tree with listing, the artifact store stays the slim-record offload for run media.

## Surfaces

| Surface | What |
| --- | --- |
| HTTP (`apps/api` `api/fs/`) | `GET /fs/entries` · `GET/PUT /fs/file` · `POST /fs/directories` · `POST /fs/move` · `DELETE /fs/entry` — thin routes over `FsService` (application-control): utf8-vs-base64 shaping on read, strict base64 decode on write, miss → 404. |
| MCP (parity) | `list_files` / `get_file` (read-classified by prefix) · `write_file` / `make_directory` / `move_file` / `delete_file` (permission-gated; `delete_` is additionally guarded in auto mode). |
| Conversational agent | Bridge-all picks the tools up with no extra wiring; the system prompt's **Files** section sets the convention and the per-turn Environment names the conversation's **task directory** (`tasks/<conversation-id>/`) — each task's working files land in its own area, and finished deliverables get promoted to the shared library (`reports/` · `data/` · `artifacts/`). |
| Web (`/[workspace]/files`) | Lazy tree + viewer/editor (Markdown preview, CodeMirror, image preview) + a bash-style shell (`ls cd cat tree mkdir touch echo>/>> cp mv rm`) sharing one directory cache. |

AuthZ: `files:read` (viewer+ — browsing is benign) / `files:write` (member+ — collaborative content
like datasets/skills). No `files:delete`: removal is ordinary content mutation, not governance.

Separation, layered: **tenant = bucket** (storage-level, inescapable) → **task = directory**
(`tasks/<conversation-id>/` — convention carried by the agent's environment block, so parallel
tasks never trample each other's files) → shared library dirs (`reports/` `data/` `artifacts/`
`skills/` `knowledge/`) for what outlives a single task.

## Skill + knowledge content lives ON the filesystem (content-projection)

`application-control/src/fs/content-projection.ts` — the SSOT layout:

```
skills/<id>/SKILL.md       # the skill's instructions
skills/<id>/files/<path>   # each supporting file
knowledge/<id>.md          # a knowledge entry's markdown body
```

`SkillService` / `KnowledgeEntryService` (when composed with `fs`):

- **Save = filesystem first.** The projection is written before the DB row; a failed projection
  fails the save, so the SSOT is never silently stale.
- **Get = filesystem first.** The projection wins when present: an out-of-band edit (shell, agent
  `write_file`) surfaces on the next read AND re-syncs the DB replica. A legacy DB-only row is
  lazily migrated onto the filesystem on first read — no destructive migration, no boot step.
- **The DB row stays a full replica** so `list` stays one query and filesystem-less processes (the
  agent server's direct store reads) keep working; a filesystem outage degrades reads to the
  replica instead of failing them.

## Boundaries / non-goals

- The filesystem is control-plane state, not the eval sandbox: a running case's working directory
  is the Driver/Environment's concern; `RepoEnvironment` snapshots stay on the artifact path.
- No per-file ACLs in v1 — the tree is workspace-shared (`files:*` gates the surface).
- 5 MiB per file, 512-char/24-segment paths, strict `[A-Za-z0-9._-]` segments.
