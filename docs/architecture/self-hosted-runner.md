# Self-hosted runner — run a workspace's harness/dataset on *your own* machine

> **Status: SHIPPED — all 6 slices landed; live e2e green (`scripts/live/self-hosted-runner.mjs`).**
> Commits: pairing CRUD (`f0ae3e4` api · `a79e42d` web) · `self:` routing + owner-check (`a2e6d11` · `78178ef` web
> selector) · `SelfHostedBackend`+`RunnerHub` lease queue (`4036215`) · MCP runner protocol + pairing-token auth
> (`104bc34`) · `everdict runner` CLI (`f0dfeca`) · provenance tag + budget split (`7c751bb`) · lease expiry/requeue +
> heartbeat + live e2e (`a8e74c1`). Five decisions locked with the user (below) all honored.
> - **D1 — ownership is personal.** A self-hosted runner is owned by `principal.subject` (the personal-ownership
>   pattern originally mirrored from Connected accounts, since removed in S6c — see
>   [workspace-scoped-integrations.md](./workspace-scoped-integrations.md)), **not** the workspace. The workspace's
>   harnesses/datasets stay shared SSOT; only the *runtime* becomes personal. It lives on the personal, self-scoped
>   surface (next to API keys), **no role gate**. Cluster runtimes (`nomad|k8s`) remain
>   workspace-shared as today.
> - **D2 — results flow back to the workspace, tagged.** A self-hosted run is a normal workspace run in
>   `RunStore`/`ScorecardStore`, carrying a **provenance tag** (`ranOn: self-hosted`, `runner=<device>`,
>   `by=<subject>`) so the team's compare/regression sees it *and* sees it ran on an unmanaged personal host.
> - **D3 — only the owner dispatches to their runner.** Owner-only is enforced by the dispatcher's owner-check
>   (`runnerStore.get(submitterSubject, runnerId)`); a non-owner — **including a workspace admin** — targeting
>   `self:<id>` gets 404. A run pinned to my self-hosted runtime leases **only to my runner**; no one else's job
>   ever lands on my machine (my login, my files), and a run there executes **as me**. The lease queue is keyed by
>   `(owner, runnerId)` — workspace-independent, so one runner serves **all** of its owner's workspaces
>   (cross-workspace); each job keeps its own `tenant` for result/budget attribution.
> - **D4 — packaging is a CLI subcommand.** `everdict runner` (in `apps/cli`) reuses `@everdict/job-runner`'s
>   `runCaseJob` verbatim. No new app; no GUI (a desktop client is a later, optional slice).
> - **D5 — transport is MCP.** The runner is an automated client → it rides the existing OAuth/API-key
>   `/mcp` (Streamable HTTP). Lease/result/heartbeat are **MCP tools**, consistent with CLAUDE.md's
>   "Humans→Keycloak; agents→API keys/MCP".
>
> Like [judge-placement-locality](./judge-placement-locality.md) and
> [front-door-generalization](./front-door-generalization.md): **strict generalization, not a clean break.**
> Every new piece is additive; the existing push backends (`nomad|k8s`) are untouched, and the
> absence of a self-hosted runner dispatches exactly as today. The in-process `local` runtime
> ([runtimes.md](../runtimes.md)) is **superseded** by this for the "run on a single machine" use case — the
> machine is now the *user's*, not the control-plane host.

## Problem

A workspace defines a harness + dataset (shared SSOT in the registry). A **member** wants to take *those exact
artifacts* and run them on **their own laptop** — to iterate quickly, against their own local repo / browser /
OS, using their **own Claude/Codex subscription login** — by changing **only the runtime**. Today the only
"single machine" runtime is `local`, which means **in-process on the control-plane host** — the wrong machine
and the wrong identity. There is no way for a user's own host to pull a workspace-registered job, run it
locally, and report the result back.

Three things make this awkward under the current model:

1. **`RuntimeSpec` is workspace-shared.** `local|nomad|k8s` are registered in the
   workspace-owned `RuntimeRegistry` (immutable versions, `_shared` fallback). A personal laptop is **not** a
   workspace asset — modeling it there would let one member's job land on another member's machine.
2. **Dispatch is push-only.** Every `Backend` *pushes* a job to an orchestrator. The control plane needs
   network reach to the compute. A personal laptop behind NAT/a firewall can't be pushed to.
3. **The trust/cost model assumes Everdict owns the sandbox.** `assertHardenedIsolation` enforces gVisor/Kata
   because eval = untrusted code on Everdict's infra. On a user's own host, isolation is the *user's* concern, and
   the *user's* subscription login pays — not the workspace's keys/budget.

**The unifying insight:** the unit of work already exists and is location-agnostic. `runCaseJob(job)`
(`packages/job-runner/src/run.ts`) takes an `CaseJob` and runs `runCase` over `LocalDriver` — and `LocalDriver`
already "uses the machine's existing login (no API key)". We only need to (a) let the *user's* machine pull that
job instead of the control plane pushing it, and (b) scope the runtime **personally** so it's the user's own
box, identity, and bill.

## Current state — verified

- **Unit of work** — `runCaseJob(job: CaseJob): Promise<CaseResult>` (`packages/job-runner/src/run.ts:13`) runs a
  whole case over `LocalDriver` (`opts.driver ?? new LocalDriver()`). `run.ts:15` already documents a dev
  fallback for "when dispatching LocalBackend directly" — exactly the self-hosted shape, minus the pull transport.
- **Job wire format** — `CaseJob` (`packages/contracts/src/execution/case-job.ts`) is Zod-validated and base64-JSON
  serializable; it already carries `tenant`, `meterUsage`, transient `repoToken`, etc. `CaseResult` is the
  return contract. The push path scrapes `__EVERDICT_RESULT__` from logs; the pull path posts `CaseResult` JSON
  directly (Zod-validated at the MCP boundary) — cleaner, no sentinel.
- **Placement selection** — a scorecard run's `runtime` selector sets `placement.target` on every case
  (`apps/api/src/execution/scorecard-service.ts`); `RuntimeDispatcher` (`apps/api/src/execution/runtime-dispatcher.ts`) resolves
  `placement.target` → tenant `RuntimeSpec` → live `Backend`, then routes through the global `Scheduler` so
  **fairness/budget/capacity/isolation are preserved**. We reuse this seam: a self-hosted target is just
  another `placement.target` value.
- **Personal-ownership precedent** — Connected accounts (since removed in S6c —
  see [workspace-scoped-integrations.md](./workspace-scoped-integrations.md)) were keyed by
  `(owner=principal.subject, id)`, managed on the account page, **no role gate**, tokens encrypted at rest
  (`ConnectionStore`), and resolved **against the submitter's subject** at dispatch (Phase 3a `repoToken`). The
  self-hosted runner mirrors this model exactly (`RunnerStore` ≈ the former `ConnectionStore`).
- **MCP surface** — `apps/api/src/mcp.ts` already hosts role-gated, API-key-authenticated tools with full
  BFF↔MCP parity. Personal tools (`list_api_keys`, `list_runners`, …) demonstrate the **no-role-gate, subject-scoped**
  pattern the runner tools follow.

## Design

### Where the runner lives (D1) — a personal "Connected runner", not a workspace `RuntimeSpec`

A self-hosted runner is a **personal device pairing**, stored in a new `RunnerStore` (`@everdict/db`), keyed by
`(owner=principal.subject, runnerId)` with a non-key `workspace` column (where it was paired) — the same shape
as the former `ConnectionStore`. Metadata: `label` (device name), `os`, `capabilities[]` (e.g. `repo`, `browser`,
`os-use`, `docker`), `lastSeenAt`, `connectedAt`. It is **not** in the workspace `RuntimeRegistry` (which stays
the immutable, workspace-shared SSOT for `nomad|k8s`).

It nonetheless **surfaces as a runtime choice**: the scorecard Run form's existing runtime selector merges in
the caller's own runners as `My local host — <label>` options. Selecting one sets a synthetic
`placement.target = self:<runnerId>` (distinct from a registry runtime id). This is the user's "just swap the runtime"
mental model with zero change to harness/dataset selection.

### How a job reaches the runner (D3, D5) — pull via MCP, owner-scoped lease queue

Dispatch direction flips from push to **pull**, absorbed as one new `Backend` so the `Scheduler` machinery is
untouched:

```
Today (push):  control plane → Backend.dispatch(job) → Nomad/K8s runs the job-runner image → parse __EVERDICT_RESULT__
Self-hosted:   member's `everdict runner` → MCP lease_job (long-call) → runCaseJob(job) locally → MCP submit_result
```

- **`SelfHostedBackend`** (`@everdict/backends`) — `dispatch(job)` does **not** push to a cluster. It enqueues the
  job into a **lease queue keyed by `(owner, runnerId)`** (workspace-independent → cross-workspace) and returns a
  promise that the matching `submit_result` resolves. `capacity()` = `maxConcurrent`; jobs park until a runner
  leases them, bounded by a lease/queue timeout (no connected runner ⇒ jobs wait then reject — natural scale-to-zero).
- **`RuntimeDispatcher` branch** — when `placement.target` matches `self:<runnerId>`, resolve it against the
  **submitter's** `RunnerStore` (owner = `principal.subject`), exactly as Phase 3a resolves a `connectionId`
  against the submitter's subject. **Reject** if the runner isn't owned by the submitter (you cannot target
  someone else's machine). Build/look up the `SelfHostedBackend` keyed to that runner and route via the
  `Scheduler`. No self-hosted runner registered / not owned → no fallthrough to a cluster (explicit error — a
  self-hosted pin is intentional).
- **MCP runner tools** (subject-scoped, no role gate — personal, like `list_api_keys`):
  - `lease_job {runnerId, capabilities, waitMs}` → long-call returning the next `CaseJob` pinned to a
    self-runner **owned by the leasing subject**, or empty on timeout (the runner re-polls). Double-sided
    enforcement: the queue only holds the owner's jobs, and the tool only serves the owner's queue.
  - `submit_result {runnerId, jobId, result}` → Zod-validated `CaseResult`; resolves the parked `dispatch`
    promise; writes to `RunStore`/`ScorecardStore`.
  - `heartbeat_job {runnerId, jobId}` → extends the lease; expiry → **requeue** (a dead runner never
    black-holes a job).
  - Pairing/management tools — `pair_runner`, `list_runners`, `revoke_runner` — with **BFF parity** (account
    page) since those are also human-facing.

### Trust, budget, provenance (D2)

- **Isolation** — a self-hosted runner is the user's own host, so `assertHardenedIsolation` is **bypassed** for
  this kind (its trust zone = "user-owned host"; blast radius is the user's own machine, opted into). The result
  is **tagged** as an unmanaged host so the workspace can weight regression/compare trust accordingly.
- **Budget** — the user's own subscription login pays. A self-hosted run **does not draw the workspace's
  token/usd budget**; it counts only against `runs` (so quota still applies). The harness's reported
  `total_cost_usd` is recorded as **provenance**, not billed to the workspace.
- **Provenance tag** — the `CaseResult`/run record carries `{ ranOn: "self-hosted", runner: <runnerId/label>,
  by: <subject> }`. This is the D2 "recorded in the workspace + tagged" outcome.

### Reuse vs new

| Piece | Status |
|---|---|
| `runCaseJob` / `CaseJob` / `CaseResult` (base64-JSON) | **reused verbatim** — the whole point |
| API-key auth (`@everdict/auth`), `Scheduler`/`FairQueue`/`BudgetTracker`, `RunStore`/`ScorecardStore` | **reused** |
| Runtime selector → `placement.target` → `RuntimeDispatcher` | **reused** (new `self:` branch) |
| Personal ownership model (`owner=subject`, account page, encrypted at rest, no role gate) | **mirrored** from Connected accounts (since removed in S6c) |
| `RunnerStore` (`@everdict/db`) + pairing | **new** |
| `SelfHostedBackend` + owner-scoped lease queue | **new** (`@everdict/backends`) |
| MCP tools `lease_job`/`submit_result`/`heartbeat_job` + pairing tools (BFF parity) | **new** (`apps/api`) |
| `everdict runner` CLI (MCP client driving `runCaseJob`) | **new** (`apps/cli`) |

## Slices (all shipped; `pnpm` gates + live e2e green at each step)

1. ✅ **`RunnerStore` + pairing** — personal entity (mirrors the former `ConnectionStore`): pair (token shown once,
   SHA-256-hashed at rest), list, revoke; BFF + MCP parity; mig `0025_create_runners`. Account page "Connected runners".
   **Superseded UI note (desktop D7)**: the browser's manual pairing modal was later removed — personal-machine
   pairing is the desktop app's one-click (`docs/architecture/desktop-app.md`); the browser account page is
   manage-only (list/live status/revoke + a desktop-download CTA). The `POST /runners` API/MCP surface is
   unchanged and is the **headless path**: pair with an API key, then `everdict runner --pair <rnr_…>`.
2. ✅ **Runtime selector merge + `self:` routing** — scorecard Run form lists the caller's own runners as
   `self:<runnerId>`; `RuntimeDispatcher` recognizes `self:` (resolve + owner-check → 404 if unowned). `CaseJob.submittedBy`
   threads the subject. (Shipped with a stub backend, replaced in slice 3.)
3. ✅ **`SelfHostedBackend` + `RunnerHub` lease queue** — in-memory owner-scoped FIFO park queue; `dispatch` parks +
   awaits the post-back; `capacity()` = `maxConcurrent`. `queueTimeoutMs` rejects unleased jobs.
4. ✅ **MCP runner protocol + `everdict runner`** — `runnerAuthenticator` (pairing token `rnr_` → `Principal{via:"runner",
   runnerId}`, least-privilege); MCP `lease_job`/`submit_job_result`/`fail_job`/`heartbeat_job` (runner-token only);
   CLI authenticates to `/mcp` (StreamableHTTP), leases in a loop, runs `runCaseJob` (this machine's login), posts back.
5. ✅ **Provenance + budget** — `CaseResult.provenance{ranOn,runner,by}` stamped control-plane-side by `SelfHostedBackend`;
   self-hosted runs skip the workspace usd/tokens budget (own login pays; `runs` still counted). Isolation-bypass is by
   construction (never routes through `TrustZone`).
6. ✅ **Robustness + live e2e** — lease expiry → requeue (`leaseTtlMs`), `heartbeat` lease-extension (CLI heartbeats
   during long jobs); `scripts/live/self-hosted-runner.mjs` proves pair → run on `self:<id>` → succeeded + provenance
   tag (live-verified on the in-memory API + scripted harness, no keys/external deps).

## Follow-ups
- ✅ **Long-poll `lease_job`** (`aaf2b81`) — `RunnerHub.leaseWait(key, waitMs)` parks the runner until the next
  `enqueue` or `wait_ms` timeout; MCP `lease_job{wait_ms?}` (omit = immediate, back-compat); CLI `--wait-ms` (25s).
- ✅ **Runner presence in the web** (`e9821cc`) — online/offline dot + label on the account roster, derived from
  `lastSeenAt` freshness (long-poll lease touches it ~every 25s). Page-load-time state (not live-updating).
- ✅ **Diagnosability — "why isn't my runner doing work?"** Two complementary signals so a stuck/absent runner is
  never a black box:
  - **Dispatch-time offline diagnostic (Phase 1).** Before a self-hosted case parks, `RuntimeDispatcher` checks
    runner *liveness*, not just existence/capability. `resolveSelfRunner`/`poolRunners` now carry `online`
    (`@everdict/domain` `isRunnerOnline` — the same 90s window the web uses). No runner paired (404) and no
    *capable* runner (400) stay **hard** failures (they can never succeed); a capable-but-**offline** runner is a
    **soft** signal — the job still parks (it runs the moment the runner reconnects, or fails at the ~5-min idle
    timeout), but the dispatcher fires `DispatchOptions.onWaiting(reason)` with an actionable sentence naming the
    offline runner(s). The scorecard batch appends it as ONE `dispatch/info` step (deduped per batch), so the
    user sees "Runner X is offline — start or reconnect it" immediately instead of a silent 5-min "queued".
  - **Runner self-reported live status (Phase 2).** The runner carries a short status on every lease/heartbeat
    ("idle" / "running N job(s)" / "no Docker daemon" / "last job failed [class]: …" / "cannot reach control
    plane: …"); the control plane overlays it on the roster read (never stored; expired after ~2 min of silence)
    and the workspace runner card renders it colored by severity — an "online but stuck" runner reads at a glance.
  - **Live execution log stream (Phase 3) — the log twin of `report_case_screen`.** While it runs a case, the
    runner pushes its per-case lifecycle lines (`▶ Started` / `✓ Completed` / `✗ Failed [class / stage]: reason`)
    to the control plane via the `report_case_log` MCP tool, keyed by the CP-minted runId. `LiveLogStore` (in-
    memory, append-only, generous TTL since a log is cumulative history) buffers them, and `RunService.logs()`
    prefers the pushed log over the managed-backend tail (a self-hosted runner has no backend the CP can tail).
    The existing `GET /runs/:id/logs` route + `LiveLogs` web widget light up with zero new read/UI code — the run
    detail page's live-log panel shows what the runner is doing, live. (Same wiring fix registered the previously-
    unforwarded `liveFrames` on the MCP endpoint, so `report_case_screen` push works in production too.)
- ✅ **Case-level parallelism (`--max-concurrent`)** — the runner runs N lease workers concurrently
  (`runLeaseWorkers`, `packages/self-hosted-runner/src/runner-loop.ts`), all sharing one MCP session. `RunnerHub.lease` is
  single-thread-atomic, so concurrent `lease_job` calls never hand the same job out twice → the workers safely
  split a batch. A scorecard submitted with `concurrency=N` parks N jobs; effective parallel = `min(N, workers)`.
  Default 1 (serial, back-compat). For `service` harnesses the shared `DockerTopologyRuntime` makes
  `ensureTopology` **single-flight** (concurrent ensures of the same `id@version` join one deploy — no
  `docker run --name` collision); the topology stays per-version warm and only the per-case browser is per-job.
- ✅ **Cross-workspace leasing** (`7db1271`) — a runner serves **all** of its owner's workspaces. The lease key
  dropped its workspace pin → `(owner, runnerId)` (`self:<owner>:<runnerId>`); jobs from any workspace the owner
  belongs to land in one queue and the runner leases them all. Each job keeps its own `tenant`, so results/budget/
  notify record to the correct workspace. Owner-check unchanged (owner-only). Live-verified: one runner served
  `default` + `team-b`, each tagged with its own tenant.

## Decisions / non-goals

- **Admin targeting a member's runner — NO (settled, owner-only, no override).** A runner is the member's *personal*
  machine; an admin must **not** be able to send jobs to it. Enforced structurally: `RuntimeDispatcher` owner-checks
  `runnerStore.get(submitterSubject, runnerId)`, so any non-owner (incl. a workspace admin) targeting `self:<id>`
  gets 404. No `shared` flag, no admin override.
- **Desktop GUI client** — CLI (`everdict runner`) covers the headless case; a Tauri/Electron app is a separate later effort.
- **Replacing push backends** — `nomad|k8s` are unchanged; self-hosted is additive.

## Multi-replica / high availability

The default lease hub (`RunnerHub`) is **in-process**: jobs are parked in a per-replica in-memory queue, and
the dispatch promise a runner resolves lives in the replica that parked it. This is correct for a single
control-plane process (dev, and most self-hosted deployments). With **multiple API replicas**, though, a
runner long-polling replica A cannot lease a job parked on replica B — that job idle-times-out and the case
fails as `no_runner` even though a runner is connected. The timeout error names this cause so it is not silent.

**Store-backed hub (`EVERDICT_SELF_HOSTED_STORE_HUB=1`):** the fix — `StoreRunnerHub` over a shared
`RunnerJobStore` (Pg migration 0055 `everdict_runner_jobs`), the same cross-replica shape as
`StoreCallbackRendezvous`: `park`/`claim` (FOR UPDATE SKIP LOCKED, so two replicas never double-claim) /
`complete` persist to Postgres, and the parking replica claims the result by polling the row; the idle timeout
is enforced off `activity_at` (kept fresh cross-replica by lease/heartbeat, so a busy runner's heartbeat still
protects the jobs queued behind it). Capability gating is stored at park and filtered on claim. The lease-hub
surface is `RunnerHubLike = RunnerHub | StoreRunnerHub`; callers `await` the methods (a no-op against the
in-memory hub's synchronous returns). Opt in only for a genuinely multi-replica deployment — the store hub
polls Postgres, so single-process runs should stay on the default in-memory hub.

Without the store hub, either run self-hosted dispatch on a **single replica**, or make the load balancer
**pin a runner's lease/heartbeat and its matching dispatch to the same replica** (session affinity keyed by the
runner owner). Managed backends (nomad/k8s) are unaffected — they place through the orchestrator, not the
in-memory hub, so only the self-hosted pull path has this constraint.

## See also

[runtimes.md](../runtimes.md) · [workspace-scoped-integrations.md](./workspace-scoped-integrations.md) · [execution-backends.md](../execution-backends.md) ·
[judge-placement-locality](./judge-placement-locality.md) · skills `backends`, `api-layer`.
