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

## W3 — the two rules autonomy needs beyond retention

**Every session fact names the agent behind it.** `SandboxActor.agent` / `create({agent})` (threaded from
the MCP session's declared attribution) stamps `causedBy: agent:<id>:<conversation>` on creation, snapshot
and terminal facts — loop guard #1's key, so an autonomous agent never wakes on its own snapshot. The
attribution is persisted on `session.agent` **on the row**, because the paths that emit LAST — expiry, and
the crash-path reaper in a different process — must carry the same key the creation fact did. A
member-driven session stamps nothing: `causedBy` names an agent or is absent.

(`run.snapshotted` stays out of `TRIGGERABLE_EVENT_KINDS`. Making it triggerable is now *safe* rather than
obviously unsafe, but it is a separate decision with its own blast radius — the guard belongs to the kind,
not to this slice.)

**Capacity is agent-aware.** A flat per-tenant cap was written for members clicking a button; an agent
holding worlds across hibernates changes what it means. Two rules, the same shape as the scheduler's class
fairness (interactive must never starve behind background work):

1. an agent holds at most `EVERDICT_SANDBOX_MAX_PER_AGENT` sessions of its own (default 1 — a world is
   meant to be worked in, then hibernated), and
2. **agents never take the last tenant slot**; one stays reserved for a member. The reserve applies only
   where the cap leaves room for it, so a 1-slot deployment doesn't ban agents outright.

Both refusals name what holds the capacity and **when the next slot frees** (`freesAt`) — "retry shortly"
is not something a caller, human or agent, can act on.

## W4 — snapshotting without a daemon

`docker commit` only exists where the control plane and the container share a host. A world placed on a
cluster — the point of moving worlds off the control-plane host — has no such daemon in reach, and the
platform does not run a build service. But an image is a base plus layers, and appending one is **pure
registry protocol**: upload a blob, rewrite the config's `rootfs`/`history`, PUT a manifest
(`appendLayer` in `@everdict/images`). No builder, no daemon, no privileged anything.

The capture reads the session's work tree over the **exec channel** — `tar -C / … everdict | gzip | base64`
— because base64-over-exec is the one encoding every placement already agrees on (`docker exec`,
`nomad alloc exec`, `kubectl exec`). That is what makes the path placement-independent; it also bounds it,
so a tree past `EVERDICT_WORLD_MAX_CAPTURE_BYTES` (default 2 GiB compressed) is **refused by name** rather
than truncated into an image that boots missing files.

Mechanism selection: `driver.snapshot` first (the bytes never cross the control plane, and it captures the
whole filesystem rather than the work tree), this as the fallback. A deployment with neither is refused at
session CREATE, not hours later.

Two rules the live drill wrote:

- **The tar is rooted at `/` and names the directory** (`tar -C / … everdict`), not taken from inside it. An
  image layer's paths are root-relative, so `tar -C /everdict .` yields `./proj/…`, which unpacks to
  `/proj/…` — beside where it came from. The drill's first snapshot published cleanly and the next session
  read the OLD file; nothing but a real registry unpacking a real layer would have shown it.
- **The compressed digest goes in the manifest, the UNCOMPRESSED one (diffID) in the config.** Conflating
  them publishes an image that pulls and then fails to unpack, so `appendLayer` computes both itself rather
  than accepting them.

A multi-platform base is refused: snapshotting would have to pick an architecture, and a world is one
running filesystem.

## W4/W5 — one placement target, two modes

`Backend` is one-shot `dispatch(CaseJob) → CaseResult`; a session is not that shape. The first cut answered
that with a **separate class** (`NomadSessionDriver`) implementing the `Driver` contract over the same
orchestrator — which worked, and was wrong in a way that only shows up once you look at the whole target:
one cluster now had **two owners**. The session lane re-derived the address, the ACL token, the namespace and
the trust zone; and because the scheduler only knows the objects in its registry, a held-open session
consumed a machine the capacity probe never counted. Running a harness and founding a world are the same
compute under two modes, so they are one object:

**`NomadBackend implements Backend, Driver`** — `dispatch` places a case, `provision` holds one open. The
session mode submits a Nomad **`Type:"service"`** job with `RestartPolicy{Attempts:0}` (the container's
filesystem IS the session — a silent restart would hand back a fresh one and lose the work), waits for a
running allocation, and returns a handle whose `exec` shells `nomad alloc exec`. `writeFile`/`readFile` ride
that channel as base64. `dispose`/`reap` purge the job, and the compute id is self-describing
(`job|alloc|namespace`) because the reaper in a later process gets nothing but that string off the run row.
Both modes submit under the `everdict-` prefix, so **`capacity()` counts a session** exactly as it counts a
case. `DockerBackend` is the same story on a host: it already owned a `DockerDriver` internally, and now says
so in its type.

Which targets have the mode is a **typed capability, not a feature-detect** — `isSessionable(backend)`, the
guard shape `.claude/rules/backends.md` prescribes for every other capability (`isObservable`, `isShellable`,
…). K8s has no session mode and simply does not implement it, so asking for one is a 400 before anything is
placed rather than a failure inside the first exec. The guard narrows to `Driver`, the contract the session
service already consumes, so nothing below the backends layer learned a new type.

Everything the session service already does — worlds, hibernation, git, retention, capacity, causedBy, the
trajectory — then works off the control-plane host **with no changes at all**. Two properties make that true:

- `NomadBackend` has **no `snapshot()`** (it cannot reach a daemon), so the service automatically takes the
  registry layer-append path. That is why W4's snapshot half had to land first. `DockerBackend` does have it,
  and takes the cheap commit-and-push path — the capability, again, decides.
- `ComputeSpec.tenant` carries whose session it is, so the driver resolves the **same trust-zone policy** the
  dispatch lanes use (namespace + isolation runtime, `assertHardenedIsolation`) — a session runs untrusted
  code exactly as an eval case does and must not be isolated by a second, nearby rule.

`EVERDICT_SANDBOX_DRIVER=nomad` + `EVERDICT_SANDBOX_NOMAD_ADDR` (`_TOKEN`, `_NAMESPACE`) selects the
deployment's default compute; `docker` stays the default and the faster path where the control plane and the
container share a host.

**A workspace can place a session on its OWN runtime.** `create({runtime})` names a registered `RuntimeSpec`
— the same axis a run's `placement.target` names — and the composition turns that spec into compute through
**`buildRuntimeBackend`, the same builder the dispatch lane uses** (cached per `tenant:id@version`,
cluster-API credentials from the tenant's secret store, never in the alloc env), then narrows it with
`isSessionable`. A session therefore inherits the tenant's cluster credentials, trust zone and capacity
envelope by construction, instead of a second builder that has to remember all three. The
runtime lands on the run row (`runtime` + `placement.where:"runtime"`), which matters twice over: the console
can say where a shell actually ran, and the **crash-path reaper resolves the same driver from the row** — a
default-driver reap would silently miss a container living on the workspace's cluster. Likewise a snapshot
asks the driver that HOLDS the session, not the deployment default, because a cluster session has no daemon
to commit with even where the default driver does.

A runtime the workspace does not have is a **404 naming it** — never a quiet fall back to the deployment's
compute, which would run a tenant's code somewhere they did not choose. A runtime whose target has no session
mode is a 400 saying so — the guard above, at the composition edge.

**Founding a world needs the base copied in.** A manifest may only reference blobs its own repository holds,
and a genesis base lives elsewhere (`debian:stable-slim` is on Docker Hub). The daemon path hid this — a
`docker commit` push uploads the base's layers with the new one — so on a cluster the first snapshot failed
and no world could be created at all. `copyImage` brings the base in first (blobs before the manifest that
names them, skipping what the target already has, an index resolved to its runnable linux/amd64 child), and
`remoteImageSource` speaks the ordinary v2 bearer handshake so a public base needs no configuration.

**Hibernation captures through the compute it was handed, not the live map.** `teardown` removes the session
from that map first (so a concurrent close stays idempotent) and hibernates after; a capture that re-read the
map found nothing exactly when hibernation mattered, and the close looked clean —
`closedReason: closed, snapshots: []`. A crash-orphaned session on a daemonless placement now says plainly
that it cannot be hibernated rather than skipping silently.

### Drilled live (`nomad agent -dev` + the managed registry)

Found a world from a Docker Hub base → exec → snapshot v1 (base copied in) → re-enter on a fresh allocation
with the file intact → work → close hibernates v2 → re-enter reads both lines → the Nomad job is purged. The
whole session service ran unchanged; only the driver differed.

## Not yet (the rest of the arc)

- **Queueing**: a refused create is a refusal, not a wait. `freesAt` makes waiting a decision the caller can
  take, but the platform does not take it for them.
- **A crash-orphaned session cannot be hibernated on a daemonless placement** — the capture needs an exec
  channel this control plane no longer has. Rebuilding a handle from the recorded compute id would close it.
- **A credentialed git push has not been drilled live** (W2) — it needs a GitHub App installation, which
  grants real write access to a repository and is the workspace owner's call to make.
