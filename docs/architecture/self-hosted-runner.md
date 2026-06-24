# Self-hosted runner — run a workspace's harness/dataset on *your own* machine

> **Status: SHIPPED — all 6 slices landed; live e2e green (`scripts/live/self-hosted-runner.mjs`).**
> Commits: pairing CRUD (`f0ae3e4` api · `a79e42d` web) · `self:` routing + owner-check (`a2e6d11` · `78178ef` web
> selector) · `SelfHostedBackend`+`RunnerHub` lease queue (`4036215`) · MCP runner protocol + pairing-token auth
> (`104bc34`) · `assay runner` CLI (`f0dfeca`) · provenance tag + budget split (`7c751bb`) · lease expiry/requeue +
> heartbeat + live e2e (`a8e74c1`). Five decisions locked with the user (below) all honored.
> - **D1 — ownership is personal.** A self-hosted runner is owned by `principal.subject` (like
>   [Connected accounts](../connections.md)), **not** the workspace. The workspace's harnesses/datasets stay
>   shared SSOT; only the *runtime* becomes personal. It lives on the **account** page (next to 연결된 계정 /
>   API keys), self-scoped, **no role gate**. Cluster runtimes (`docker|nomad|k8s|topology`) remain
>   workspace-shared as today.
> - **D2 — results flow back to the workspace, tagged.** A self-hosted run is a normal workspace run in
>   `RunStore`/`ScorecardStore`, carrying a **provenance tag** (`ranOn: self-hosted`, `runner=<device>`,
>   `by=<subject>`) so the team's compare/regression sees it *and* sees it ran on an unmanaged personal host.
> - **D3 — only the owner dispatches to their runner.** The lease queue is keyed by `(workspace, subject,
>   runnerId)`. A run pinned to my self-hosted runtime leases **only to my runner**; no one else's job ever
>   lands on my machine (my login, my files), and a run there executes **as me**.
> - **D4 — packaging is a CLI subcommand.** `assay runner` (in `apps/cli`) reuses `@assay/agent`'s
>   `runAgentJob` verbatim. No new app; no GUI (a desktop client is a later, optional slice).
> - **D5 — transport is MCP.** The runner is an automated client → it rides the existing OAuth/API-key
>   `/mcp` (Streamable HTTP). Lease/result/heartbeat are **MCP tools**, consistent with CLAUDE.md's
>   "Humans→Keycloak; agents→API keys/MCP".
>
> Like [judge-placement-locality](./judge-placement-locality.md) and
> [front-door-generalization](./front-door-generalization.md): **strict generalization, not a clean break.**
> Every new piece is additive; the existing push backends (`docker|nomad|k8s|topology`) are untouched, and the
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

1. **`RuntimeSpec` is workspace-shared.** `local|docker|nomad|k8s|topology` are registered in the
   workspace-owned `RuntimeRegistry` (immutable versions, `_shared` fallback). A personal laptop is **not** a
   workspace asset — modeling it there would let one member's job land on another member's machine.
2. **Dispatch is push-only.** Every `Backend` *pushes* a job to an orchestrator. The control plane needs
   network reach to the compute. A personal laptop behind NAT/a firewall can't be pushed to.
3. **The trust/cost model assumes Assay owns the sandbox.** `assertHardenedIsolation` enforces gVisor/Kata
   because eval = untrusted code on Assay's infra. On a user's own host, isolation is the *user's* concern, and
   the *user's* subscription login pays — not the workspace's keys/budget.

**The unifying insight:** the unit of work already exists and is location-agnostic. `runAgentJob(job)`
(`packages/agent/src/run.ts`) takes an `AgentJob` and runs `runCase` over `LocalDriver` — and `LocalDriver`
already "uses the machine's existing login (no API key)". We only need to (a) let the *user's* machine pull that
job instead of the control plane pushing it, and (b) scope the runtime **personally** so it's the user's own
box, identity, and bill.

## Current state — verified

- **Unit of work** — `runAgentJob(job: AgentJob): Promise<CaseResult>` (`packages/agent/src/run.ts:13`) runs a
  whole case over `LocalDriver` (`opts.driver ?? new LocalDriver()`). `run.ts:15` already documents a dev
  fallback for "LocalBackend 직접 디스패치할 때" — exactly the self-hosted shape, minus the pull transport.
- **Job wire format** — `AgentJob` (`packages/core/src/agent-job.ts`) is Zod-validated and base64-JSON
  serializable; it already carries `tenant`, `meterUsage`, transient `repoToken`, etc. `CaseResult` is the
  return contract. The push path scrapes `__ASSAY_RESULT__` from logs; the pull path posts `CaseResult` JSON
  directly (Zod-validated at the MCP boundary) — cleaner, no sentinel.
- **Placement selection** — a scorecard run's `runtime` selector sets `placement.target` on every case
  (`apps/api/src/scorecard-service.ts`); `RuntimeDispatcher` (`apps/api/src/runtime-dispatcher.ts`) resolves
  `placement.target` → tenant `RuntimeSpec` → live `Backend`, then routes through the global `Scheduler` so
  **fairness/budget/capacity/isolation are preserved**. We reuse this seam: a self-hosted target is just
  another `placement.target` value.
- **Personal-ownership precedent** — Connected accounts (`docs/connections.md`) are keyed by
  `(owner=principal.subject, id)`, managed on the account page, **no role gate**, tokens encrypted at rest
  (`ConnectionStore`), and resolve **against the submitter's subject** at dispatch (Phase 3a `repoToken`). The
  self-hosted runner mirrors this model exactly (`RunnerStore` ≈ `ConnectionStore`).
- **MCP surface** — `apps/api/src/mcp.ts` already hosts role-gated, API-key-authenticated tools with full
  BFF↔MCP parity. Personal tools (`list_connections`, …) demonstrate the **no-role-gate, subject-scoped**
  pattern the runner tools follow.

## Design

### Where the runner lives (D1) — a personal "Connected runner", not a workspace `RuntimeSpec`

A self-hosted runner is a **personal device pairing**, stored in a new `RunnerStore` (`@assay/db`), keyed by
`(owner=principal.subject, runnerId)` with a non-key `workspace` column (where it was paired) — the same shape
as `ConnectionStore`. Metadata: `label` (device name), `os`, `capabilities[]` (e.g. `repo`, `browser`,
`os-use`, `docker`), `lastSeenAt`, `connectedAt`. It is **not** in the workspace `RuntimeRegistry` (which stays
the immutable, workspace-shared SSOT for `docker|nomad|k8s|topology`).

It nonetheless **surfaces as a runtime choice**: the scorecard 실행 form's existing runtime selector merges in
the caller's own runners as `내 로컬 호스트 — <label>` options. Selecting one sets a synthetic
`placement.target = self:<runnerId>` (distinct from a registry runtime id). This is the user's "런타임만 바꿔"
mental model with zero change to harness/dataset selection.

### How a job reaches the runner (D3, D5) — pull via MCP, owner-scoped lease queue

Dispatch direction flips from push to **pull**, absorbed as one new `Backend` so the `Scheduler` machinery is
untouched:

```
Today (push):  control plane → Backend.dispatch(job) → Nomad/K8s runs the agent image → parse __ASSAY_RESULT__
Self-hosted:   member's `assay runner` → MCP lease_job (long-call) → runAgentJob(job) locally → MCP submit_result
```

- **`SelfHostedBackend`** (`@assay/backends`) — `dispatch(job)` does **not** push to a cluster. It enqueues the
  job into a **lease queue keyed by `(workspace, subject, runnerId)`** and returns a promise that the matching
  `submit_result` resolves. `capacity()` = the owner's currently-connected runners' free slots → **0 connected
  runners ⇒ jobs queue until a runner connects** (natural scale-to-zero), bounded by a lease/queue timeout.
- **`RuntimeDispatcher` branch** — when `placement.target` matches `self:<runnerId>`, resolve it against the
  **submitter's** `RunnerStore` (owner = `principal.subject`), exactly as Phase 3a resolves a `connectionId`
  against the submitter's subject. **Reject** if the runner isn't owned by the submitter (you cannot target
  someone else's machine). Build/look up the `SelfHostedBackend` keyed to that runner and route via the
  `Scheduler`. No self-hosted runner registered / not owned → no fallthrough to a cluster (explicit error — a
  self-hosted pin is intentional).
- **MCP runner tools** (subject-scoped, no role gate — personal, like `list_connections`):
  - `lease_job {runnerId, capabilities, waitMs}` → long-call returning the next `AgentJob` pinned to a
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
  by: <subject> }`. This is the D2 "workspace에 기록 + 태그" outcome.

### Reuse vs new

| Piece | Status |
|---|---|
| `runAgentJob` / `AgentJob` / `CaseResult` (base64-JSON) | **reused verbatim** — the whole point |
| API-key auth (`@assay/auth`), `Scheduler`/`FairQueue`/`BudgetTracker`, `RunStore`/`ScorecardStore` | **reused** |
| Runtime selector → `placement.target` → `RuntimeDispatcher` | **reused** (new `self:` branch) |
| Personal ownership model (`owner=subject`, account page, encrypted at rest, no role gate) | **mirrored** from Connected accounts |
| `RunnerStore` (`@assay/db`) + pairing | **new** |
| `SelfHostedBackend` + owner-scoped lease queue | **new** (`@assay/backends`) |
| MCP tools `lease_job`/`submit_result`/`heartbeat_job` + pairing tools (BFF parity) | **new** (`apps/api`) |
| `assay runner` CLI (MCP client driving `runAgentJob`) | **new** (`apps/cli`) |

## Slices (all shipped; `pnpm` gates + live e2e green at each step)

1. ✅ **`RunnerStore` + pairing** — personal entity (mirrors `ConnectionStore`): pair (token shown once,
   SHA-256-hashed at rest), list, revoke; BFF + MCP parity; mig `0025_create_runners`. Account page "연결된 러너".
2. ✅ **Runtime selector merge + `self:` routing** — scorecard 실행 form lists the caller's own runners as
   `self:<runnerId>`; `RuntimeDispatcher` recognizes `self:` (resolve + owner-check → 404 if unowned). `AgentJob.submittedBy`
   threads the subject. (Shipped with a stub backend, replaced in slice 3.)
3. ✅ **`SelfHostedBackend` + `RunnerHub` lease queue** — in-memory owner-scoped FIFO park queue; `dispatch` parks +
   awaits the post-back; `capacity()` = `maxConcurrent`. `queueTimeoutMs` rejects unleased jobs.
4. ✅ **MCP runner protocol + `assay runner`** — `runnerAuthenticator` (pairing token `rnr_` → `Principal{via:"runner",
   runnerId}`, least-privilege); MCP `lease_job`/`submit_job_result`/`fail_job`/`heartbeat_job` (runner-token only);
   CLI authenticates to `/mcp` (StreamableHTTP), leases in a loop, runs `runAgentJob` (this machine's login), posts back.
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
- **Deliberately deferred (non-goals — need a product/security decision before building):**
  - **Desktop GUI client** — a separate Tauri/Electron app; the CLI (`assay runner`) covers the headless case.
  - **Admin-targeting a member's runner** — sending workspace jobs to someone's *personal* machine needs explicit
    **opt-in consent** (e.g. a per-runner `shared` flag the owner sets) before an admin may target it. Today: owner-only.
  - **Cross-workspace leasing** — one physical runner serving multiple of the owner's workspaces; needs the lease key
    to drop its workspace pin, with the isolation implications that follow. Today: a runner serves the workspace it was
    selected in.

## Non-goals (this pass)

- **Desktop GUI client** — CLI (`assay runner`) first; a Tauri/Electron app is a later slice.
- **Admin targeting a member's runner** — only the owner dispatches to their own runner (D3). Opt-in sharing is
  a future consideration with explicit consent.
- **Cross-user runner sharing / a workspace runner pool** — self-hosted is personal by construction.
- **Replacing push backends** — `docker|nomad|k8s|topology` are unchanged; self-hosted is additive.

## See also

[runtimes.md](../runtimes.md) · [connections.md](../connections.md) · [execution-backends.md](../execution-backends.md) ·
[judge-placement-locality](./judge-placement-locality.md) · skills `backends`, `api-layer`.
