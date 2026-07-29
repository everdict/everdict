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
- **Self-hosted deploy**: the full compose stack (`deploy/compose/docker-compose.full.yaml`, one-shot
  `deploy/compose/full.sh`) ships a MinIO service wired to the api (`EVERDICT_S3_*` from
  `MINIO_ROOT_USER/PASSWORD`; `full.sh` generates the password with the other required secrets), so the
  filesystem is durable + bucket-isolated out of the box.
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
| Web (`/[workspace]/files`) | Lazy tree + viewer/editor (every class in **File types** below — prose, tables, code, media, download) + a bash-style shell (`ls cd cat tree mkdir touch echo>/>> cp mv rm`) sharing one directory cache. |
| Settings › Files | The workspace filesystem browsed in-service (never the object-storage console): the page is the folder tree ALONE, and a selected file renders interactively in the right-hand split-view panel (the infra panel's purpose-built `files` tab — the full **File types** matrix below, member editing; a panel-side mutation bumps `fsRevision` so the tree refetches in place). No shell and no storage/cleanup surface here. `GET /fs/usage` + `DELETE /fs` (settings:write) stay API/MCP-only ops surfaces (`get_fs_usage` / `delete_all_files`). |

**The tree owns the entry actions** (both web surfaces); the viewer only reads and edits the open document —
it has neither a Move nor a Delete button, because acting on a file belongs where the folder context and the
selection live.

- **Relocation is drag-and-drop**, never a path dialog: drag an entry onto a folder row — or onto the tree
  body for the top level — and the tree calls `POST /fs/move`. The drop is refused where the filesystem would
  reject it anyway (onto itself, back into its current folder, into its own subtree); hovering a collapsed
  folder mid-drag opens it, and the target expands after the drop so the entry is visible where it landed.
- **Multi-select** (checkbox per row, shift-click ranges, Esc clears, floating action bar — the scorecard-list
  grammar) fans **delete** and **move** out over a whole selection: dragging a checked row carries all of it,
  and the action bar's "Move to…" reaches destinations a drag can't (collapsed or scrolled away). Redundant
  paths are pruned before the fan-out (a folder and something inside it act once, as the folder), a partial
  failure reports per path and leaves the rest retryable, and the selection is deliberately NOT persisted
  across reloads — a path is not a stable id, so a move or delete would restore ghosts.
- A row-level trash covers the single-entry delete without checking a box first. Folders delete recursively.

⚠️ **S3 batch delete is off-limits** (`S3WorkspaceFs.deleteKeys`): removal fans out single `DeleteObject`
calls, never `DeleteObjects`. MinIO — the storage the self-hosted stack ships — requires a `Content-MD5`
header on `DeleteObjects` that aws-sdk-js v3 no longer sends (its CRC32 checksum default; no client option
or explicit `ChecksumAlgorithm` restores it). The batch call fails on every such deployment, which took down
recursive removes AND directory moves — and since a move copies before it deletes, the failure duplicated
the tree. Regression guard: `packages/storage/src/s3-fs.scenario.test.ts` (env-gated live MinIO).

AuthZ: `files:read` (viewer+ — browsing is benign) / `files:write` (member+ — collaborative content
like datasets/skills). No `files:delete`: removal is ordinary content mutation, not governance. Reading a
file's history is a read (`files:read`); restoring a revision is a write (`files:write`).

Separation, layered: **tenant = bucket** (storage-level, inescapable) → **task = directory**
(`tasks/<conversation-id>/` — convention carried by the agent's environment block, so parallel
tasks never trample each other's files) → shared library dirs (`reports/` `data/` `artifacts/`
`skills/` `knowledge/`) for what outlives a single task.

## Revisions — who published what, and safe concurrent editing

Every write PUBLISHES a revision. The tree is shared by members *and* by agents acting for them, so two
questions had to become answerable: **who changed this file** and **what happens when two authors write at
once**. Both are handled in one place — `RevisionedWorkspaceFs` (`application-control` `fs/`), a decorator
over any `WorkspaceFs` composed once in `main.ts`. Nothing downstream opts in: the web editor, the agent's
`write_file`, the shell and the skill/knowledge projections all publish through it.

```
FsRevision = { path, revision, size, contentType, hash, actor, message?, restoredFrom?, createdAt }
FsActor    = { kind: member|agent|system, subject, agentId?, agentName?, conversationId?, onBehalfOf? }
```

- **Two planes.** The ledger (`FsRevisionStore` port → `PgFsRevisionStore` / `InMemoryFsRevisionStore`,
  migration `0089`) holds the audit rows; the immutable bytes live in object storage via
  `writeRevisionBlob`/`readRevisionBlob`. On S3 those go to the tenant's **sibling revision bucket**
  (`fsRevisionBucketFor`) — a separate bucket rather than a reserved prefix, so no tree operation ever has to
  filter the internals out of a listing.
- **The uniqueness constraint IS the allocator.** `append` writes `(tenant, path, revision)` under a primary
  key; a duplicate is a lost race and throws `ConflictError` instead of overwriting. Write order is blob →
  ledger row → head object, so a crash can strand an unreferenced blob but never publish a file whose
  authorship went unrecorded.
- **Optimistic writes.** A writer states `baseRevision` (the revision it edited; `0` = "this file should not
  exist yet"). If the head moved on, the write is refused — `PUT /fs/file` → **409** whose `data` is the full
  resolution kit: the live content plus a three-way merge (`mergeThreeWay`, the pure line-based diff3 in
  `@everdict/domain`; chunked by CHANGES, so edits on adjacent lines merge cleanly and only overlapping hunks
  conflict). One round trip is enough for either resolver — the web's merge dialog and an agent re-applying
  its edit. Omitting `baseRevision` is a blind overwrite that still publishes a revision.
- **Attribution.** The HTTP/MCP caller is always the member (apps/agent forwards their bearer), so the agent
  identity travels as headers — `x-everdict-agent-id` / `-agent-name` / `-conversation-id`, set per
  conversation by apps/agent and read at MCP `initialize`. That is provenance, not privilege: a forged header
  can only mislabel the caller's own publish. `actor=agent` + `onBehalfOf=<member>` is what the history shows.
- **Append-only, retained indefinitely** (product decision — no pruning). A restore re-publishes an old
  revision's bytes as a NEW revision carrying `restoredFrom`, so a rollback is itself audited. A move rewrites
  the ledger's stored path (`rename`), so history follows a file instead of starting over; a deleted path keeps
  its history, and re-creating it continues the numbering.
- **Surfaces**: `GET /fs/revisions` · `GET /fs/revisions/content` · `POST /fs/revisions/restore`, with MCP
  parity (`list_file_revisions` / `get_file_revision` / `restore_file_revision`, plus `write_file`'s
  `base_revision`). The web renders them as the viewer's **History** panel (author line, publish message,
  revision preview, restore) and the **merge dialog** on a refused save.
- Listings deliberately carry no revision (that would be a ledger query per row); `stat`/`read`/`write` do.

## File types

The tree is general-purpose: an agent drops a spreadsheet next to a shell script next to a screenshot. So the
type registry aims for **breadth** — `packages/contracts/src/records/workspace-file.ts` is the SSOT (extension →
content type, plus extension-less names like `Dockerfile`/`Makefile`/`LICENSE` and a dotfile convention for
`.gitignore`/`.env.local`). An unmapped extension degrades to `application/octet-stream`, which every surface
treats as an opaque blob — that is the last resort, never the answer for an ordinary file.

**Two axes, deliberately separate.** `isFsTextContentType` is the ENCODING question (can these bytes round-trip
as utf-8, inline in an API response and editable in the viewer?) and drives `FsFileContent.encoding`.
`fsFileClassOf` is the PRESENTATION question (what medium is this?). Only formats that are genuinely both differ
between them: `image/svg+xml` is markup you can edit AND a picture you can look at. Source formats with no
registered IANA type get `text/x-<lang>`, so the `text/` prefix makes a new language text-detectable for free.

**A stored fallback is re-guessed on read.** `application/octet-stream` on an existing object was never a
decision about that file — it means the registry had no row for the extension at write time. `FsService.readFile`
re-resolves it and returns the resolved type on the entry, so every format the registry learns applies
**retroactively** to files already in storage: a `.go` or an `.xlsx` written months ago opens as code or as a
document today, with no migration and no rewrite. A type that was an actual decision is never second-guessed.

| Class | Formats | Viewer (`features/browse-files/ui/document-preview.tsx`) |
| --- | --- | --- |
| prose | `.md` `.markdown` `.mdx` | rendered Markdown + a **Raw** toggle |
| tabular | `.csv` `.tsv` | grid (first 200 rows, quoted fields honoured) + Raw |
| code / text | ~110 extensions + named files + dotfiles | CodeMirror, ~35 highlighted languages, member-editable |
| image | `png` `jpg` `gif` `webp` `bmp` `ico` `tiff` `avif` `heic` `svg` | inline; svg also opens as editable markup |
| pdf | `.pdf` | embedded `<object>` viewer |
| audio / video | `mp3` `wav` `ogg` `flac` `m4a` `aac` / `mp4` `webm` `mov` `avi` `mkv` | native player |
| document | `docx` `xlsx` `pptx` `doc` `xls` `ppt` `odt` `ods` `odp` `hwp` `hwpx` `rtf` `epub` | named state + **Download** |
| archive | `zip` `tar` `gz` `tgz` `bz2` `xz` `7z` `rar` `jar` `whl` | named state + Download |
| binary | everything else (`parquet` `sqlite` `wasm`, model weights, …) | size + Download |

Download is offered for **every** file, not only the ones that cannot render: the bytes are already in the
response, so the browser builds a blob URL client-side (`lib/file-bytes.ts`) — no second round trip, no
presigned-URL surface to secure. Office documents are classified apart from opaque binaries on purpose: an
`.xlsx` is a readable deliverable, so the state names what it is instead of shrugging.

Adding a format is **two edits**: a row in the contracts table, and a branch in `DocumentPreview`. The web keeps
its own mirror of the class tables (`lib/file-kind.ts`) because runtime-decoupling forbids importing contracts
values — keep the two in step.

### Where each type can go next

The registry answers "does it open". These are the openings for "does it *work*", roughly in ascending cost.
None is committed; the point is that each one is a branch in one switch, not a new subsystem.

- **Code → run it.** The ChatGPT-artifact move, and the one Everdict is best placed for: the execution layer
  already exists (Driver + `case.image`, the self-hosted runner, topology sandboxes). "Run this file" is
  placement plus an output pane, not a new engine — a `.py`/`.sh` dispatched to the workspace's default runtime,
  stdout streamed back, outputs written into the same folder. The invariant to hold: it runs in the tenant's
  isolation, never on the control plane.
- **Notebooks (`.ipynb`).** Today they render as JSON. Cell-wise rendering (markdown cells + code + stored
  outputs) is presentation-only; executing them is the same unlock as running code, one step later.
- **Spreadsheets.** The CSV grid is the seed — sorting, column stats and a row count are cheap follow-ons.
  `.xlsx` needs a parser (SheetJS-class dependency); worth it only when someone asks. The eval-native move
  beyond preview is **"open as dataset"**: datasets are already a first-class entity, and a sheet of cases is
  exactly that shape.
- **Office documents.** Inline preview means server-side conversion (headless LibreOffice or a converter
  service) — a real dependency and its own sandbox. The cheap intermediate is text extraction for the agent and
  the knowledge layer, so a `.docx` becomes searchable without becoming viewable.
- **Markdown.** Rendered already; the openings are in-place authoring and the link graph the knowledge/skill
  bodies already live on (`knowledge/<id>.md`).
- **Images.** Annotation and image-to-image diff — screenshot regression across runs is an eval-native use, not
  a generic viewer feature.
- **Media.** Trace-aligned playback: a browser run's recording scrubbed against its trace events (see
  `docs/replay.md`).
- **Diffs/patches.** A side-by-side view now has a natural home next to the revision history.
- **Archives / columnar data.** Listing a `.zip`'s entries without extracting, or a schema + head for
  `.parquet`/`.sqlite`, both want a runtime probe rather than in-browser parsing.

Two ceilings bound all of it: the **5 MiB per-file cap** and the fact that a read inlines the whole payload
(base64 for binaries). Large media and real datasets need range reads or presigned URLs before any of the above
is worth building on. Files also only ever arrive by agent write or the shell today — a browser upload is a
separate surface, subject to the same cap.

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
