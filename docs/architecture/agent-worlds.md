# Agent worlds — persistent environments over ephemeral sandboxes

> A **world** is a durable, versioned environment an agent (or member) builds up across sandbox
> sessions: clone a repo, install a toolchain, shape a project — then the session's filesystem is
> **snapshotted as an image** and the next session **boots from it**. The container is disposable;
> the world persists. W1 of the sandbox-flexibility arc (see the harness playground for the session
> substrate: `docs/architecture/harness-playground.md`).

## The model: sandbox = compute, world = image lineage

No new entity. A world is:

- an **environment capability** (`kind: environment`) whose id names the world — versions are
  filesystem snapshots, registered through the normal `CapabilityService.save` patch-bump flow
  (immutable versions, `latest` moves, visibility defaults `workspace`);
- a **repository in the managed image store** named by the same id (`IMAGE_REPOSITORY_NAME` in
  `@everdict/domain` — the world id must BE a valid single-segment repository name), tags `v1, v2, …`;
- `RunSession.world` / `hibernate` / `snapshots[]` on the session run's row (`records/run.ts`,
  jsonb — no migration), so the crash-path reaper can act from the row alone.

```
create_sandbox({world:{id}})     ── boot the world's latest snapshot (or found from `image`: genesis)
        │
        ▼
   work (exec / tasks)           ── the world grows; touch_sandbox extends the deadline
        │
        ▼
snapshot_sandbox                 ── docker commit → push v<n> → capability version @ digest
        │
        ▼
close / TTL expiry = HIBERNATE   ── auto-snapshot before the container dies (default for worlds)
        │
        ▼ (later: a member, an agent turn, a schedule…)
create_sandbox({world:{id}})     ── continue from the last snapshot
```

## Load-bearing decisions

- **Snapshots are host-side.** `Driver.snapshot?(computeId, ref, auth?)` (`DockerDriver`:
  `docker commit` → `docker --config <tmp> push` → `rmi`) runs against the daemon, not inside the
  container — the push grant **never enters the compute**, so it can never be baked into the
  captured image. No build tooling is required in the sandbox; the "control plane never builds"
  non-goal stands (a commit is a capture, not a build).
- **Expiry is hibernation, not loss.** `teardown` (close AND expiry) auto-snapshots a world session
  before `dispose()` when `hibernate` is on (default for world sessions; `close {snapshot:false}`
  overrides per-call). A snapshot failure never blocks teardown — it lands on the trajectory as
  `session.snapshot_failed`.
- **The crash path hibernates too.** `reap()` on a running row with no live handle reads
  `session.{world, hibernate, computeId}` + `createdBy` and captures the orphan container before
  removing it.
- **Touch never shortens.** `Run.extendSession` sets `expiresAt = max(current, now+ttl)`; the
  durable reaper gains an `extend` signal (best-effort), and `reap()` re-checks the authoritative
  deadline so a stale timer fires a **no-op**, never an early teardown.
- **Digest-pinned, prose carried forward.** The published capability version pins
  `repo:v<n>@sha256:…` (`pinDigest` — the digest read back from the registry, the authority on what
  was stored). Name/description/instructions carry forward from the world's latest version unless
  the snapshot restates them, so auto-hibernate never blanks an author's prose.
- **The fact is `run.snapshotted`** (axis `evaluation`), emitted through the run row's E0 outbox
  write. Deliberately **not** trigger-matchable in v1 — an agent waking on its own snapshot is loop
  guard #1's textbook vector. Making it triggerable is a W3 decision alongside `causedBy` review.

## W2 — a repository in, commits out

A world is where work accumulates, so it has to be able to take a repository in and give commits back.
Both halves are credential problems, and both are solved the same way: **the credential belongs to the
command, never to the session.**

- **In** — `create({repo:{git, ref?, dir?}})` clones before the record exists (a session handed over without
  the repo it was asked for is a lie the member only discovers by looking). The read credential is a GitHub
  App installation token (`contents:read`) that reaches git through `gitAuthEnv` — `http.extraheader` in the
  ENVIRONMENT, never argv (`ps` is world-readable) and never `.git/config` (that file would travel inside
  every later snapshot of this world). A public repo clones anonymously. Full clone, not depth-1: this tree
  is meant to be worked in and pushed from. `session.repo` on the row records what the tree IS.
- **Out** — `POST /sandboxes/:id/git/push` (`sandbox_git_push`) mints a `contents:write` token **at the
  moment of the push**, uses it for that one command, and drops it. Committing stays the caller's own job
  through `exec` — `git add`/`commit` need no credential, and the one thing a container cannot do for itself
  is authenticate. The remote URL is read from the **container**, not the create-time record: the working
  tree is the truth about what is being pushed. `pullRequest:{title, body?}` additionally opens a PR for the
  pushed branch against the repo's default branch (`openPullRequestForBranch` — the sibling of
  `openPullRequest` that proposes what git already delivered instead of authoring content through the API).

`sandbox_git_push` is a **guarded** agent tool (it mints a write credential and lands code on a real remote);
`sandbox_exec` deliberately stays unguarded — a container is the agent's own scratch space until its contents
leave for a repository.

## Surface (BFF ↔ MCP parity)

| HTTP | MCP | gate |
| --- | --- | --- |
| `POST /sandboxes` (`world`, `hibernate`, `repo` added) | `create_sandbox` | `runs:submit` |
| `POST /sandboxes/:id/snapshot` | `snapshot_sandbox` | `images:push` (capability owner rule inside the publish) |
| `POST /sandboxes/:id/git/push` | `sandbox_git_push` | `github:write` + creator-or-admin in the service |
| `POST /sandboxes/:id/touch` | `touch_sandbox` | `runs:read` + creator-or-admin in the service |
| `POST /sandboxes/:id/close` (`snapshot` override added) | `close_sandbox` | `runs:read` + creator-or-admin |

World sessions **refuse at create** (400) when the deployment cannot snapshot — no managed image
store (`EVERDICT_IMAGE_STORE_*`), no capability service, or a driver without `snapshot` — instead of
failing hours of work later at the first snapshot.

## W3 — retention: the bound autonomy needs

A world gains a version on every hibernate, and the managed registry has no GC of its own. An autonomous
loop that snapshots each time it wakes therefore grows storage forever — so the version line is **bounded**:
after a successful publish, `pruneWorldVersions` drops the oldest versions past
`EVERDICT_WORLD_KEEP_VERSIONS` (default 10), **capability versions and the image bytes behind them**
(dropping only the version would leave the registry holding blobs nobody can name).

Three rules make the bound safe:

- **Which versions fall outside is a domain rule**, not a call-site guess: `versionsBeyondKeep` keeps the
  newest N by the same ordering `latest` resolution uses and returns the rest **oldest-first**, so an
  interrupted prune leaves the newest intact. `keep < 1` prunes nothing — a retention policy that could
  empty the line is a bug, not a configuration.
- **Retention is not a delete channel.** `CapabilityService.pruneVersions` SKIPS a version another member
  published (it logs which) rather than failing or deleting it: a shared world can carry several authors,
  and a bound must never become a way to remove someone else's work.
- **It runs after the publish and can never undo it.** The snapshot the caller is waiting on already
  exists; a registry that refuses a delete must not turn that success into a failure. What was removed is
  reported (`prunedVersions` on the snapshot result) — a silent bound is indistinguishable from data loss.

## Not yet (the rest of the arc)

- **W3 remainder — autonomy**: `causedBy` stamping on session facts + the trigger-matchability review for
  `run.snapshotted`, and per-agent compute budgets (with queueing) instead of the flat per-tenant session
  caps, which two autonomous agents in one workspace collide on immediately.
- **W4 — placement**: world sessions on cluster runtimes (the Nomad browser-session `Type:"service"`
  precedent) — requires wiring trust zones into dispatch, and a snapshot mechanism that does not
  assume a host-local docker daemon.
