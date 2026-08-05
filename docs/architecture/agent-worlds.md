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

## Surface (BFF ↔ MCP parity)

| HTTP | MCP | gate |
| --- | --- | --- |
| `POST /sandboxes` (`world`, `hibernate` added) | `create_sandbox` | `runs:submit` |
| `POST /sandboxes/:id/snapshot` | `snapshot_sandbox` | `images:push` (capability owner rule inside the publish) |
| `POST /sandboxes/:id/touch` | `touch_sandbox` | `runs:read` + creator-or-admin in the service |
| `POST /sandboxes/:id/close` (`snapshot` override added) | `close_sandbox` | `runs:read` + creator-or-admin |

World sessions **refuse at create** (400) when the deployment cannot snapshot — no managed image
store (`EVERDICT_IMAGE_STORE_*`), no capability service, or a driver without `snapshot` — instead of
failing hours of work later at the first snapshot.

## Not in W1 (the rest of the arc)

- **W2 — git in/out**: clone with a GitHub App installation token at session create; per-call
  re-minted write tokens for push/PR from inside the world.
- **W3 — autonomy**: guarded-tool policy for the snapshot/credential tools, `causedBy` stamping +
  trigger-matchability review, per-world retention (keep-last-N; the image store still has no GC),
  per-agent compute budgets instead of the flat per-tenant session caps.
- **W4 — placement**: world sessions on cluster runtimes (the Nomad browser-session `Type:"service"`
  precedent) — requires wiring trust zones into dispatch, and a snapshot mechanism that does not
  assume a host-local docker daemon.
