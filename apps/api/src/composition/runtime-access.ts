import { randomUUID } from "node:crypto";
import {
  type DriverAuthority,
  type RecoveryTarget,
  type ReplicaRegistry,
  type ResumeResult,
  recoverInterrupted,
  retryDeferredRecovery,
  tombstoneInterrupted,
  verifierOperation,
} from "@everdict/application-control";
import type { ExecutionAttemptStore, RunService } from "@everdict/application-control";
import type { ScorecardService } from "@everdict/application-control";
import type { AdmissionLedger, AgentHalfStore } from "@everdict/application-control";
import { recoverVerifiedCase } from "@everdict/application-control";
import {
  type Backend,
  type LogStream,
  adoptionStep,
  backendSlotOf,
  isScreenAttachable,
  isScreenCapturable,
  isTopologyInspectable,
  isVerifierDispatchable,
  isWorkAddressable,
  isWorkControllable,
  slotAdmits,
} from "@everdict/backends";
import type {
  AdoptedWork,
  AdoptionDecision,
  CaseResult,
  KillOutcome,
  ReadResult,
  RegistryAuth,
  RunRecord,
  RuntimeSpec,
  RuntimeWorkRef,
  Score,
  TraceEvent,
  VerifierInvocation,
  VerifierJob,
  WorkPresence,
} from "@everdict/contracts";
import { NotFoundError, RateLimitError, UpstreamError, readOrUnknown, worstKillOutcome } from "@everdict/contracts";
import type { CasePlacement, TopologyStatus } from "@everdict/contracts/wire";
import type { RunStore, ScorecardStore } from "@everdict/db";
import type { BudgetTracker } from "@everdict/domain";
import type { RuntimeRegistry } from "@everdict/registry";

// Per-runtime backend access for already-dispatched cases: adoption/kill (boot recovery, supersede) + the
// live-observability reads (logs / one-shot exec / terminal stream / browser frame). Resolves the recorded
// runtime lane (possibly a comma shard list) to live backends via the shared runtime builder/auth path.
// Keep a permit alive for as long as its container runs. Exactly the Scheduler's shape — a timer that lives
// only while a permit is held and never pins the process — because a second renewal policy is a second answer
// to "how long may a holder go silent" (arch-review 61 P1).
function startRenewal(
  slots: { ledger: Pick<AdmissionLedger, "renewAdmissions"> },
  permitId: string,
  everyMs = 600_000,
): { stop: () => void } {
  if (slots.ledger.renewAdmissions === undefined) return { stop: () => undefined };
  const timer = setInterval(() => {
    void slots.ledger.renewAdmissions?.([permitId])?.catch?.(() => undefined);
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function buildRuntimeAccess(deps: {
  runtimeRegistry: RuntimeRegistry;
  runtimeSecretsFor: (tenant: string) => Promise<Record<string, string>>;
  runtimeBuildBackend: (
    spec: RuntimeSpec,
    opts: { secretEnv?: Record<string, string>; registryAuths?: RegistryAuth[] },
  ) => Backend;
  // The attempt ledger, so a verifier's compute gets a row like every other piece of managed work
  // (arch-review 57 P0-verifier). Optional: a deployment without one records nothing and still judges —
  // refusing there would make the ledger a prerequisite for a verdict rather than a record of one.
  attempts?: ExecutionAttemptStore;
  // ── THE VERIFIER TAKES COMPUTE, SO IT PASSES ADMISSION (arch-review 59 P1-high) ──────────────────
  //
  // Rule `backends`: anything that takes compute passes the admission gate BEFORE a container is
  // provisioned, and releases on any failure that produced nothing. The agent's half does, through
  // `Scheduler.dispatch`. This lane resolves a backend and calls it directly, so a batch of 500 private-
  // verifier cases placed 500 further containers — each one running the tenant's own task image, for a
  // time bounded by the case's own `timeoutSec` — with no budget reservation and nothing to 402 against.
  // A workspace at its cap could not submit another run and was, at that moment, doubling its container
  // count anyway.
  //
  // Admission, not the queue: `Scheduler.dispatch` is task-shaped over `Backend.dispatch`, and a verifier
  // is dispatched through `VerifierDispatchable` with a different payload — routing it through the queue
  // would mean giving the scheduler a second dispatch verb. What the lanes share is the GATE, which is what
  // the rule says and all this needs.
  admitVerifierCompute?: BudgetTracker;
  // ── …AND A SLOT, FROM THE SAME LEDGER THE SCHEDULER USES (arch-review 60 P1-high) ────────────────
  //
  // The budget gate above limits SPEND — cumulative usd/tokens/run-count. It says nothing about how many
  // containers a tenant may hold at once, and those are different questions: a batch with budget headroom
  // placed its agent halves through the Scheduler's capacity and fairness, then submitted every verifier
  // straight at the backend. The judging half doubled the fleet's container count against limits it never
  // consulted.
  //
  // Not a second queue: `AdmissionLedger` is the fleet-wide, atomic, per-tenant permit the Scheduler already
  // claims for exactly this, so sharing it means the two halves draw on ONE pool rather than two accountings
  // that must agree. A deployment without a ledger admits as before — the ledger is what makes the limit
  // fleet-wide, and its absence is the single-replica case, not a bypass.
  verifierSlots?: {
    // …including RENEWAL (arch-review 61 P1). The ledger's permit is a 30-minute LEASE and the Scheduler
    // renews the ones it holds every ten; this lane was handed only `tryAdmit`/`releaseAdmission`, so a
    // verifier running longer than the lease had its permit reaped while its container kept going — another
    // execution could then claim the slot it was still occupying, and the fleet quietly exceeded the quota
    // by that verifier's share. A capability a holder is not given is a lease it cannot keep.
    ledger: Pick<AdmissionLedger, "tryAdmit" | "releaseAdmission" | "renewAdmissions">;
    // How often to renew, matching the Scheduler's default. A verifier is bounded by the case's own
    // `timeoutSec`, which a tenant may set well past the lease.
    renewEveryMs?: number;
    quotaFor: (tenant: string) => number;
    newPermitId: () => string;
  };
}) {
  const { runtimeRegistry, runtimeSecretsFor, runtimeBuildBackend, attempts, admitVerifierCompute, verifierSlots } =
    deps;
  // Boot-recovery adoption + supersede force-kill: resolve each runtime of the child's recorded lane (may be a
  // comma shard list) to a live backend and use its optional adopt/kill. A LANE that cannot be resolved is
  // silent here by design (adoption falls back to re-dispatch); the KILL paths below no longer treat that
  // silence as success — see `killWork`/`killUnhandled`.
  //
  // Verifier containers THIS PROCESS is currently holding, per backend. `capacity()` reports what the cluster
  // can see, and a placement is not visible there until its object exists — so without this, concurrent
  // verifiers all read the same free slot and all take it. Exactly the Scheduler's own local accounting
  // (`inFlight`, subtracted from the capacity snapshot), in the lane that dispatches around it.
  const verifiersHeld = new Map<string, { count: number; memoryMb: number; cpu: number }>();
  const eachRuntimeBackend = async (
    tenant: string,
    runtimeList: string | undefined,
    // The resolved TARGET travels with the backend: `Backend` has no identity member, and a caller that
    // keeps per-runtime state (the verifier lane counts the slots it is holding) needs a stable key.
    fn: (backend: Backend, target: string) => Promise<boolean>, // return true to stop iterating (handled)
  ): Promise<{ unresolved: string[] }> => {
    const targets = (runtimeList ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "" && !t.startsWith("self:")); // self-hosted lanes are lease queues — nothing to adopt/kill
    // ── A LANE THAT COULD NOT BE RESOLVED IS NOT AN EMPTY LANE (arch-review 53, Wave A.5) ────────────
    //
    // `runtimeRegistry.get(...).catch(() => undefined)` used to collapse two situations into one skip: the
    // tenant deregistered this runtime (a real absence) and the registry could not be read (a failover, a
    // network partition). The kill paths below fold their per-backend answers with `worstKillOutcome`, whose
    // identity is `absent` — so a teardown that reached NO cluster, asked NOTHING and learned NOTHING
    // returned a CONVERGED answer and the cancellation operation completed on it. The strong
    // `KillOutcome.unknown` value existed the whole time and no code path could produce it here.
    //
    // Reported rather than swallowed. Adoption still treats an unresolvable lane as silence (it falls back to
    // re-dispatch, which is safe), and the kill paths turn each entry into an explicit `unknown`.
    const unresolved: string[] = [];
    for (const target of targets) {
      const spec = await runtimeRegistry.get(tenant, target).catch((err: unknown) => {
        unresolved.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      if (!spec) continue;
      const secretEnv = await runtimeSecretsFor(tenant).catch(() => ({}) as Record<string, string>);
      const backend = runtimeBuildBackend(spec, { secretEnv });
      if (await fn(backend, target)) return { unresolved };
    }
    return { unresolved };
  };

  // The per-lane answers a kill fan-out could not obtain. An unresolvable lane and a backend that cannot be
  // ASKED about the work are the same fact — "the postcondition is unestablished" — and `absent` is reserved
  // for having asked and been told there is nothing there.
  const unknownFor = (reasons: string[], what: string): KillOutcome[] =>
    reasons.map((reason) => ({ status: "unknown" as const, reason: `${what}: runtime unresolved — ${reason}` }));

  // ── ADOPTION, ADDRESSED BY THE HANDLE (arch-review 53, Wave B) ────────────────────────────────────
  //
  // Adoption is not an observability read: it HARVESTS a finished job and hands the result back as this
  // execution's own, which decides what a receipt vouches for. The case-id form it replaces resolved "the
  // newest job of this case", and two runs of one case are two jobs — so it could hand run A the verdict run
  // B's job produced. It is GONE (arch-review 53, legacy removal): a row with no handle has no managed work
  // this system can name, and recovery re-dispatches rather than adopting a job it cannot identify.
  // A UNION, NOT A VALUE BESIDE A FLAG (arch-review 54, Phase 2). This used to answer
  // `{ result?: CaseResult; established: boolean }`, and `established` was set to false on `unknown` under a
  // comment saying the caller must not re-dispatch on it. No caller ever read the flag. `resumeRun` took
  // `outcome.result`, found it undefined, and re-dispatched — which is what the flag existed to prevent, for
  // a whole review cycle, with the reason written directly above the line.
  //
  // A companion boolean can be half-consumed and a discriminated union cannot: there is no way to reach the
  // result without saying which case you are in. The lanes are also genuinely three, not two — "we took a
  // finished job's verdict", "the cluster says there is nothing to take", and "nobody could tell us" — and
  // the third is the one whose cost is two live attempts of one execution.
  const adoptWorkFn = async (
    tenant: string,
    runtimeList: string | undefined,
    work: RuntimeWorkRef,
  ): Promise<AdoptionDecision> => {
    let harvested: AdoptedWork | undefined;
    let unresolved: string | undefined;
    const { unresolved: lanes } = await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend)) return false;
      const outcome = await backend.adoptWork(work);
      // `adoptionStep` owns what one lane's answer MEANS — exhaustive there, so a status added later stops
      // compiling instead of falling through to whichever arm happens to be last. That is precisely how
      // `inert` arrived: the lanes learned to report it, the compiler was happy, every suite was green, and
      // what a recovery did with it was nobody's decision (arch-review 62 P0).
      const step = adoptionStep(outcome);
      if (step.kind === "harvest") {
        // The STAGE travels — this seam does not decide what an answer means, it carries what it is
        // (arch-review 60 P0). Collapsing it to a `CaseResult` here is what let a verifier's verdict reach
        // `Run.adopt` as a run's whole result.
        harvested = step.adopted;
        return true;
      }
      if (step.kind === "unresolved") unresolved = "a runtime could not say whether this work is still live";
      return false;
    });
    if (harvested !== undefined) return { kind: "adopted", adopted: harvested };
    // A lane we could not even resolve is the same fact as a cluster that would not answer: nothing about
    // this work's liveness was established, so nothing may be decided from it.
    if (unresolved !== undefined) return { kind: "unknown", reason: unresolved };
    if (lanes.length > 0) return { kind: "unknown", reason: `runtime unresolved — ${lanes.join("; ")}` };
    return { kind: "absent" };
  };

  // Live-progress log read — same lane resolution as adoption; the first backend with a readable log wins.
  // stream=stderr reads the job's stderr (harness progress); default stdout (the result stream).
  const readCaseLogsFn = async (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    stream?: LogStream,
    // REQUIRED (arch-review 53, legacy removal). There is no case-id fallback any more: it resolved "the
    // newest job of this case", which is another run's whenever two runs of one case are live. A caller
    // holding no handle has no live view to ask for, and `undefined` is the honest answer.
    work?: RuntimeWorkRef,
  ): Promise<string | undefined> => {
    if (!work) return undefined; // no handle, no live view — see the parameter note
    let text: string | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend)) return false;
      text = await backend.logsForWork(work, stream).catch(() => undefined);
      return text !== undefined;
    });
    return text;
  };

  // The managed live trajectory (observability ⑨) — decode the case job's EVENT_SENTINEL stdout lines via the
  // first backend that can read them. Same lane resolution as logs; best-effort.
  const readCaseEventsFn = async (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    work?: RuntimeWorkRef,
  ): Promise<TraceEvent[] | undefined> => {
    if (!work) return undefined;
    let events: TraceEvent[] | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend)) return false;
      events = await backend.eventsForWork(work).catch(() => undefined);
      return events !== undefined;
    });
    return events;
  };

  // Open an interactive shell stream on a case's live sandbox (observability ⑥) — same lane resolution as logs.
  const openTerminalStreamFn = async (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    work?: RuntimeWorkRef,
  ) => {
    if (!work) return undefined;
    let handle: import("@everdict/backends").ExecStreamHandle | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend) || backend.execStreamInWork === undefined) return false;
      handle = await backend.execStreamInWork(work).catch(() => undefined);
      return handle !== undefined;
    });
    return handle;
  };

  // Live browser frame (observability ⑦) — resolve the run's runtime to a topology backend and capture its
  // per-case browser CDP screen by runId. Only ServiceTopologyBackend implements captureScreen.
  const captureBrowserScreenFn = async (
    tenant: string,
    runtimeList: string | undefined,
    runId: string,
  ): Promise<string | undefined> => {
    let b64: string | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isScreenCapturable(backend)) return false;
      b64 = await backend.captureScreen(runId).catch(() => undefined);
      return b64 !== undefined;
    });
    return b64;
  };

  // Where a run's live browser can be REACHED (⑦b, interactive) — the address the takeover relay drives, as
  // opposed to a frame of it. Same lane resolution as the capture; only topology backends can answer.
  const screenEndpointFn = async (
    tenant: string,
    runtimeList: string | undefined,
    runId: string,
  ): Promise<string | undefined> => {
    let endpoint: string | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isScreenAttachable(backend)) return false;
      endpoint = await backend.screenEndpoint(runId).catch(() => undefined);
      return endpoint !== undefined;
    });
    return endpoint;
  };

  // One-shot exec into a case's live sandbox (web terminal / live screen) — same lane resolution as logs.
  const execInSandboxFn = async (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    command: string,
    // A command runs INSIDE a container — an exec resolved by case id is a write into a world the caller
    // never named (arch-review 53, Wave B). With a handle it lands in the sandbox it was issued for.
    work?: RuntimeWorkRef,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> => {
    if (!work) return undefined;
    let out: { stdout: string; stderr: string; exitCode: number } | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend)) return false;
      out = await backend.execInWork(work, command).catch(() => undefined);
      return out !== undefined;
    });
    return out;
  };

  // Case-scoped placement read (runtime debugging) — same lane resolution as logs; the first backend that can
  // describe the case's job wins. Answers "is my case blocked on capacity / stuck pulling / OOM-looping" live.
  const inspectCasePlacementFn = async (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    work?: RuntimeWorkRef,
  ): Promise<CasePlacement | undefined> => {
    if (!work) return undefined;
    let placement: CasePlacement | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend)) return false;
      placement = await backend.inspectWork(work).catch(() => undefined);
      return placement !== undefined;
    });
    return placement;
  };

  // Topology health roster (runtime debugging) — resolve the run's runtime lane to a topology-capable backend
  // and read the harness's warm-topology per-service status. Only ServiceTopologyBackend answers.
  const inspectTopologyFn = async (
    tenant: string,
    runtimeList: string | undefined,
    harness: { id: string; version: string },
  ): Promise<TopologyStatus | undefined> => {
    let status: TopologyStatus | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isTopologyInspectable(backend)) return false;
      status = await backend.inspectTopology(harness, tenant).catch(() => undefined);
      return status !== undefined;
    });
    return status;
  };

  // One deployed topology service's log tail — same lane resolution as the roster read.
  const topologyServiceLogsFn = async (
    tenant: string,
    runtimeList: string | undefined,
    harness: { id: string; version: string },
    service: string,
  ): Promise<string | undefined> => {
    let text: string | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isTopologyInspectable(backend)) return false;
      text = await backend.topologyServiceLogs(harness, service, tenant).catch(() => undefined);
      return text !== undefined;
    });
    return text;
  };

  // Stop the EXACT work a dispatch created (arch-review 52, Wave 2) — the handle the backend reported and the
  // attempt ledger persisted. Every runtime of the shard list still gets the call, because the handle says
  // which cluster's object it is only as far as the recorded lane goes; on a cluster that never placed it, an
  // exact id simply matches nothing, which is the difference from the case-id kill below (that one MATCHES on
  // every cluster, and stops whatever it finds there).
  //
  // ── AND IT ANSWERS (arch-review 52, Wave 3) ──────────────────────────────────────────────────────
  // This used to be `.catch(() => {})` over a `Promise<void>`, which meant the ONE caller written to treat a
  // failed teardown as its own failure could never see one: `RunService.stopRun` wraps the kill in an
  // `UpstreamError` precisely so the cancellation stays owed, and the arm it awaited resolved cleanly while
  // the cluster job kept running. The seam aggregates the lane's per-backend answers and returns the WORST
  // one; the caller decides what to do about it. Nothing here swallows.
  const killWork = async (
    tenant: string,
    runtimeList: string | undefined,
    work: RuntimeWorkRef,
  ): Promise<KillOutcome> => {
    const outcomes: KillOutcome[] = [];
    const { unresolved } = await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkAddressable(backend)) {
        // Resolvable and unaskable. Nothing was confirmed about this work, so nothing may be certified.
        outcomes.push({
          status: "unknown",
          reason: `killWork ${work.externalJobId}: this runtime cannot be addressed by work handle`,
        });
        return false;
      }
      // A backend that THREW is still a failure, not a silence — `killWork` is contractually total, so this
      // only fires on a broken implementation, and turning it into `failed` is what keeps that honest.
      outcomes.push(
        await backend.killWork(work).catch(
          (err: unknown): KillOutcome => ({
            status: "failed",
            reason: `killWork ${work.externalJobId}: ${err instanceof Error ? err.message : String(err)}`,
          }),
        ),
      );
      return false;
    });
    return worstKillOutcome([...outcomes, ...unknownFor(unresolved, `killWork ${work.externalJobId}`)]);
  };

  // ── THE JUDGING HALF'S LANE (arch-review 56, Wave K) ──────────────────────────────────────────────
  //
  // A case whose grading depends on material the agent must not see is refused by `caseJobPayload` on a lane
  // that runs both in one container. This resolves the lane that can run the judging half on its own, so the
  // refusal becomes a second dispatch instead of a dead end. A runtime that cannot do it answers by NOT being
  // wired — `withVerifierPass` then records the verdict as `unmeasured`, which is the honest reading of "this
  // deployment cannot judge this case away from its agent".
  const dispatchVerifier = async (job: VerifierJob): Promise<VerifierInvocation> => {
    let invocation: VerifierInvocation | undefined;
    // BEFORE any lane is resolved — see `admitVerifierCompute`. Over the cap this throws
    // `PaymentRequiredError` (402), which `withVerifierPass` records as an owed verdict rather than a
    // fabricated one, so a workspace out of budget gets an unmeasured case and not a free container.
    // ── EVERY ADMISSION THIS LANE TAKES IS RELEASED BY ONE `finally` (arch-review 61 P0) ─────────────
    //
    // The budget was claimed here and the permit below it, both OUTSIDE the try — so anything that threw
    // between them left the budget reservation held forever. And something did throw, on the DEFAULT
    // deployment: `quotaFor` answers `Number.POSITIVE_INFINITY` when no tenant quota is configured, and the
    // Pg ledger binds that straight into `in_flight < $3` against an `integer` column. Postgres answers
    // `invalid input syntax for type integer: "Infinity"` — verified against a real one — so on Postgres,
    // with no `EVERDICT_TENANT_QUOTAS` set, EVERY private-verifier case threw before its lane was resolved,
    // recorded `tests_pass: unmeasured`, and permanently incremented the workspace's run count. A workspace
    // with a run budget is then 402'd for verifiers that never existed.
    //
    // The Scheduler never had this: it asks `Number.isFinite(quota)` first and claims no permit at all when
    // the quota is unlimited. Two admission paths spelling the same precondition differently is the shape
    // rule `backends` names — so this asks the same question, and every acquisition is unwound by the same
    // `finally` regardless of which step failed.
    const permitId = verifierSlots?.newPermitId();
    let budgetHeld = false;
    let permitHeld = false;
    let renewal: ReturnType<typeof startRenewal> | undefined;
    // Which backend, if any, this lane is holding a slot against — so the `finally` gives back exactly what
    // it took, and nothing when the placement never got that far.
    let laneHolding: { target: string; need: { memoryMb?: number; cpu?: number } } | undefined;
    try {
      admitVerifierCompute?.admit(job.tenant);
      budgetHeld = true;
      const quota = verifierSlots?.quotaFor(job.tenant);
      // No ledger, no quota, or an UNLIMITED one: there is no fleet-wide slot to claim, and claiming one
      // would be inventing a limit nobody configured.
      if (verifierSlots && permitId !== undefined && quota !== undefined && Number.isFinite(quota)) {
        // REFUSED and COULD-NOT-CHECK are different facts (rule `protocol` L2). `false` is the tenant at its
        // limit — a 429 a caller retries. A throw is a ledger that would not answer, which is neither a
        // refusal nor an admission: it becomes an UpstreamError, and `withVerifierPass` records it as
        // `unmeasured` naming the infrastructure rather than telling a workspace it is over a cap.
        const admitted = await verifierSlots.ledger.tryAdmit?.(job.tenant, permitId, quota).catch((err: unknown) => {
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { tenant: job.tenant },
            `the admission ledger could not say whether this workspace has room for a verifier: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
        if (admitted === false)
          throw new RateLimitError(
            "RATE_LIMITED",
            { tenant: job.tenant, quota },
            "this workspace is at its concurrent-execution limit, so its verifier cannot be placed yet.",
          );
        permitHeld = admitted === true;
        // …and KEPT. The lease outlives nothing on its own: a holder that stops renewing is reaped, and this
        // one holds its slot for as long as the container runs.
        if (permitHeld) renewal = startRenewal(verifierSlots, permitId, verifierSlots.renewEveryMs);
      }
      // The AGENT'S lane, carried on the job — not `undefined`. `eachRuntimeBackend` splits a comma list and
      // drops the empties, so `undefined` is an empty target set rather than "every runtime": it visited no
      // backend, threw NOT_FOUND, and `withVerifierPass` turned that into `tests_pass: unmeasured` on every
      // private-verifier case (arch-review 57 P0). The verifier also MUST NOT roam — it reads this tenant's
      // task image with this tenant's credentials, so the lane that ran the agent is the only correct answer.
      await eachRuntimeBackend(job.tenant, job.placementTarget, async (backend, target) => {
        if (!isVerifierDispatchable(backend)) return false;
        // ── AND THE BACKEND'S OWN ENVELOPE (arch-review 61 P1) ─────────────────────────────────────
        //
        // The tenant permit above limits how many executions ONE workspace holds. It says nothing about the
        // backend's `maxConcurrent`, which is what stops a cluster being handed more work than it has slots:
        // several tenants each inside their own quota could still put the lane past its total, and a batch's
        // verifier fan-out is exactly the shape that does it.
        //
        // Asked with the probe the Scheduler gates on, and refused with a 429 rather than queued — this lane
        // has no queue, and inventing one here would be the second scheduler rule `backends` forbids. A
        // caller retries; a container that should not exist does not get created.
        //
        // ── A PROBE THAT FAILED IS NOT HEADROOM (arch-review 62 P1) ────────────────────────────────
        //
        // `.catch(() => undefined)` followed by `room !== undefined &&` made an unreadable cluster mean
        // "place it": the same physical limit was fail-CLOSED on the Scheduler's path (a backend whose probe
        // throws is absent from its capacity map, so nothing goes there this pump) and fail-OPEN here. An
        // outage that stops us asking is exactly when a lane is most likely to be full.
        const room = await readOrUnknown(() => backend.capacity(), `capacity of runtime '${target}'`);
        if (room.kind !== "read")
          throw new RateLimitError(
            "RATE_LIMITED",
            { tenant: job.tenant, runtime: target, reason: room.kind === "unknown" ? room.reason : "no answer" },
            "this runtime could not say whether it has room for a verifier, so one was not placed.",
          );
        // ── …AND A READING IS NOT A RESERVATION (arch-review 62 P1) ───────────────────────────────
        //
        // Between this answer and the dispatch below, every other verifier this replica is placing reads the
        // same headroom and spends it too: at 19/20, three concurrent verifiers all saw one free slot and all
        // three went. The Scheduler does not have that gap because it counts its OWN in-flight placements
        // locally and subtracts them from the snapshot, so a pump cannot hand out the same slot twice.
        //
        // The same accounting, in the lane that had none. This is a per-PROCESS bound, exactly like the
        // Scheduler's: what makes the limit fleet-wide is the tenant permit above, and no claim beyond that
        // is made here (rule `protocol` L1 — observing room is not reserving room; this reserves the part
        // this process can).
        // ── AND ON THE SAME THREE AXES THE SCHEDULER USES (arch-review 62 follow-through) ─────────
        //
        // This asked `used >= total` and nothing else, while the Scheduler has always admitted on free
        // slots AND the backend's declared memory envelope AND its CPU envelope. So a verifier declaring
        // two gigabytes went onto a lane whose memory budget was already spent, and the case it judges then
        // died for a reason nothing attributes to the judging half.
        //
        // `backendSlotOf`/`slotAdmits` are that decision, exported and shared, so an axis added to one lane
        // reaches the other. What is NOT shared is the harness POOL (`capacityFor`): it answers about a
        // harness's warm sessions and a verifier is a batch container, so consulting it would refuse for a
        // reason that is not about this unit. Said here rather than left as an unexplained gap.
        const held = verifiersHeld.get(target) ?? { count: 0, memoryMb: 0, cpu: 0 };
        // SUMMED with the cluster's reading, not maxed: this lane has no pump to correct itself, and the
        // window it counts is exactly the one before a placement is visible to the probe (see
        // `backendSlotOf`). Refusing slightly early is the safe direction for a cap.
        const slot = backendSlotOf(target, room.value, {
          slots: room.value.used + held.count,
          memoryMb: held.memoryMb,
          cpu: held.cpu,
        });
        const need = { memoryMb: job.resources?.memoryMb, cpu: job.resources?.cpu };
        if (!slotAdmits(slot, need))
          throw new RateLimitError(
            "RATE_LIMITED",
            { tenant: job.tenant, runtime: target, slot, need },
            "this runtime has no room for the verifier — its slots, memory or CPU envelope are full.",
          );
        verifiersHeld.set(target, {
          count: held.count + 1,
          memoryMb: held.memoryMb + (need.memoryMb ?? 0),
          cpu: held.cpu + (need.cpu ?? 0),
        });
        laneHolding = { target, need };
        // WRAPPED so the verifier is durable work (arch-review 57 P0-verifier): its own attempt row, its
        // reservation recorded before the lane creates anything, settled either way. Cancellation builds its
        // workset from attempt rows, so this is what makes a running verifier visible to a sweep that would
        // otherwise certify zero live work over it.
        invocation = await verifierOperation({ ...(attempts ? { attempts } : {}) }, job, (j, hooks) =>
          backend.dispatchVerifier(j, hooks),
        );
        return true; // the first lane that can judge is the answer
      });
      if (invocation === undefined)
        throw new NotFoundError(
          "NOT_FOUND",
          { caseId: job.caseId },
          job.placementTarget === undefined
            ? "this case was placed on no named runtime, so there is no lane to resolve a verifier against."
            : `runtime '${job.placementTarget}' cannot run a verifier away from the agent's container — the case cannot be judged here.`,
        );
      return invocation;
    } finally {
      // The reservation is held for exactly as long as this lane may be holding a container, and released
      // once it is not — including on the paths that created nothing (no lane could judge, the placement
      // refused, the tenant's runtime is gone). Not settled: a verifier's real cost is not measured here, and
      // reserving-then-releasing is what stops a batch's fan-out from overshooting a cap that is computed
      // from committed usage. A reservation never released would 402 the workspace for containers that have
      // long since exited.
      // Both, and only what was actually taken. The slot goes back the moment this lane stops holding a
      // container, exactly as the budget reservation does; idempotent by contract, so a release racing the
      // ledger's own lease reap is harmless.
      renewal?.stop();
      if (permitHeld && permitId !== undefined)
        await verifierSlots?.ledger.releaseAdmission?.(permitId).catch(() => undefined);
      if (budgetHeld) admitVerifierCompute?.release(job.tenant);
      // …and the backend slot this lane was counting against its own snapshot. Released here with the rest,
      // for the same reason: a count never given back would refuse verifiers for containers that exited long
      // ago, which is the failure mode a cap is supposed to prevent rather than cause.
      if (laneHolding !== undefined) {
        const cur = verifiersHeld.get(laneHolding.target);
        const rest = {
          count: (cur?.count ?? 1) - 1,
          memoryMb: Math.max(0, (cur?.memoryMb ?? 0) - (laneHolding.need.memoryMb ?? 0)),
          cpu: Math.max(0, (cur?.cpu ?? 0) - (laneHolding.need.cpu ?? 0)),
        };
        if (rest.count > 0) verifiersHeld.set(laneHolding.target, rest);
        else verifiersHeld.delete(laneHolding.target);
      }
    }
  };

  // ── THE POSTCONDITION READ (arch-review 53, Wave E) ────────────────────────────────────────────────
  //
  // Did the object this handle names actually go away? `killWork` answers what the DELETE returned; this
  // answers what the cluster now holds. A placement view for the exact work says `dead` or answers nothing
  // (the object is gone) — either is absence; anything else is still live. A lane that cannot be resolved,
  // or a backend that cannot be asked, is `unknown`: the postcondition is unestablished and the cancellation
  // stays owed rather than completing on an optimistic reading.
  const probeWork = async (
    tenant: string,
    runtimeList: string | undefined,
    work: RuntimeWorkRef,
  ): Promise<WorkPresence> => {
    let seen: WorkPresence | undefined;
    const { unresolved } = await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend)) return false;
      // …THROUGH THE BACKEND'S OWN EXISTENCE READ (arch-review 56, Wave G). This used to derive absence from
      // `inspectWork`, which answers a display PHASE: K8s reports `queued` for a Job whose pods do not exist
      // yet, so a Job that had genuinely gone away read as live and the cancellation could never converge.
      // `probeWork` asks the question this needs — does the object exist — and says why when it cannot tell.
      seen = await backend.probeWork(work).catch(
        (err: unknown): WorkPresence => ({
          kind: "unknown",
          reason: `probeWork ${work.externalJobId}: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      return true; // the first backend that can answer about this exact object is the answer
    });
    if (seen !== undefined) return seen;
    return {
      kind: "unknown",
      reason:
        unresolved.length > 0
          ? `probeWork ${work.externalJobId}: ${unresolved.join(", ")} could not be resolved`
          : `probeWork ${work.externalJobId}: no runtime could be asked about this handle`,
    };
  };

  // ── A MANAGED LANE WITH NO HANDLE IS `unknown` (arch-review 53, legacy removal) ────────────────────
  //
  // `killCase(caseId)` is GONE. It reached every run's job of the case — and on Nomad, every namespace's —
  // and it existed only so a teardown holding no handle had SOMETHING to call. That is the wrong trade: an
  // over-broad stop is not a safer answer than no answer, it is a wrong action taken confidently, and the
  // constitution already says what an unestablished postcondition is.
  //
  // So a teardown with no handle answers by LANE KIND. A self-hosted lane (`self:*`) places no orchestrator
  // object at all — its abort arm is the lease revocation, which ran — so `absent` is the truth there. A
  // managed lane that named no work is a pre-Wave-A row (or a dispatch that died before reserving): whether
  // anything is running is unestablished, and `unknown` keeps the cancellation owed for an operator rather
  // than certifying a quiet that nobody observed.
  const killUnhandled = async (tenant: string, runtimeList: string | undefined): Promise<KillOutcome> => {
    const managed = (runtimeList ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "" && !t.startsWith("self:"));
    if (managed.length === 0) return { status: "absent" }; // lease queues only — nothing was ever placed
    return {
      status: "unknown",
      reason: `no runtime work handle was recorded for this execution on ${managed.join(", ")} — whether managed compute is still running cannot be established`,
    };
  };
  return {
    eachRuntimeBackend,
    adoptWorkFn,
    readCaseLogsFn,
    readCaseEventsFn,
    openTerminalStreamFn,
    captureBrowserScreenFn,
    screenEndpointFn,
    execInSandboxFn,
    inspectCasePlacementFn,
    inspectTopologyFn,
    topologyServiceLogsFn,
    killWork,
    killUnhandled,
    dispatchVerifier,
    probeWork,
  };
}

// Recover orphaned jobs at boot — batches/runs are tracked in-process within this process, so at restart any
// queued/running record is a ghost with no one to resume it. Interrupted BATCHES are resumed from their finished
// child results (unfinished cases re-dispatched); unresumable records fall back to failed(INTERRUPTED).
// docs/architecture/batch-resilience.md
// ── RECOVERING A STANDALONE RUN IS A PHASE, AND BOTH OWNERS RUN ALL OF IT (arch-review 59 P0-lifecycle) ──
//
// Read the ledger's work handles, adopt each one EXACTLY, then resume — with `retry_later` at every step
// where the answer was "we could not find out". Boot composed all three; the periodic sweep was wired to the
// last line, `service.resume(r, undefined, authority)`, and `undefined` is the adopted result.
//
// So a run deferred BECAUSE the cluster would not say whether its job was live came back a minute later and
// skipped the question, entering the non-adopt path — which re-dispatches. The compute that was live the
// whole time then runs twice, bills twice and writes competing evidence, and the ledger records the retry as
// a success. Two owners assembling the same transition is how they came apart; this is the transition, and
// it has one owner now.
export async function recoverStandaloneRun(
  deps: Pick<Parameters<typeof runStartupRecovery>[0], "service" | "adoptWorkFn" | "workHandlesFor"> & {
    // The physical ledger, so an adopted attempt stops reading as live work — see `closeAdopted`.
    attempts?: Pick<ExecutionAttemptStore, "transition">;
    // Where `withVerifierPass` staged the agent's half — see the verifier branch below. Absent means this
    // deployment cannot merge a recovered verdict, which is exactly what it could not do before.
    agentHalves?: AgentHalfStore;
  },
  r: RunRecord,
  authority: DriverAuthority,
): Promise<ResumeResult> {
  const { service, adoptWorkFn, workHandlesFor } = deps;
  // ── AN ADOPTED ATTEMPT IS CLOSED (arch-review 61 P2-audit) ──────────────────────────────────────────
  //
  // Adoption reads a finished container's answer and DELETES its Job. On the in-line path `verifierOperation`
  // then settles the attempt row; after a restart that code never runs, so a recovery could settle the run
  // `succeeded`, remove the external object, and leave the physical row saying `active` or `executing`
  // forever. Nothing produces a wrong verdict from that — which is why it is an audit finding and not a P0 —
  // but the ledger is the record of what physically ran, a teardown keeps chasing work that is already gone,
  // and an operator reading it is told a container is running when none is.
  //
  // ── …AND THE SETTLEMENT IS WHAT CLOSES IT (arch-review 63 P1-high) ──────────────────────────────
  //
  // This lane used to make the stamp itself — first before `service.resume`, then after it. Both were wrong
  // for the same reason and the second was worse: `committed` requires the parent to be OPEN, and a
  // successful resume is precisely what closes it, so the stamp was refused every single time and every
  // recovered attempt stayed `reserved`.
  //
  // The seam for this has existed since arch-review 45: `settleRun` takes the stamp, the store binds it into
  // the settlement's own transaction, and the two writes are one decision — ordered so the guard's question
  // still has an answer when it is asked. All this lane owes is WHICH attempt answered.
  let adoptedFrom: RuntimeWorkRef | undefined;

  // THE HANDLE FIRST (arch-review 53, Wave B). A run whose ledger row holds where its compute was
  // placed is adopted by THAT — one job, this run's. Only a row with no handle (pre-Wave-2, or a lane
  // that mints none) falls back to "the newest job of this case", which can be another run's.
  //
  // …AND AN UNREADABLE LEDGER IS NOT AN EMPTY ONE (arch-review 54, Phase 2). `.catch(() => [])` here
  // turned "the attempt ledger is down" into "this run placed no compute", which routed straight to the
  // re-dispatch below. The read answers three ways now, and only a genuine `absent` may be acted on.
  const handlesRead = workHandlesFor
    ? await readOrUnknown(() => workHandlesFor(`evd-run-${r.id}`), "the run's runtime work handles")
    : ({ kind: "absent" } as ReadResult<RuntimeWorkRef[]>);
  if (handlesRead.kind === "unknown")
    // DEFERRED, AND THE SWEEP IS TOLD (arch-review 55). This used to `return` out of a fire-and-forget
    // task while the caller had already answered `true`: the run stayed claimed by this replica,
    // `running`, with no driver and no durable retry — a zombie the next booting replica reads as
    // "another live replica is driving it".
    return { kind: "retry_later", reason: handlesRead.reason };
  const handles = handlesRead.kind === "read" ? handlesRead.value : [];
  let adopted: CaseResult | undefined;
  if (handles.length > 0 && adoptWorkFn) {
    for (const work of handles) {
      const decision = await adoptWorkFn(r.tenant, r.runtime, work).catch(
        (err: unknown): AdoptionDecision => ({
          kind: "unknown",
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      // Exhaustive: the third case is the one the previous shape allowed a caller to skip.
      // ── ONLY THE AGENT'S OWN HALF SETTLES THIS RUN (arch-review 60 P0) ──────────────────────────
      //
      // A run with a private verifier holds TWO handles under one execution id, and this loop takes the
      // first that answers. `adoptWork` used to answer a `CaseResult` for both, so when the agent's Job had
      // been reaped and the verifier's was still there, the verifier's shell — `harness: "verifier"`, empty
      // trace, empty snapshot — went to `Run.adopt`, which writes `status: "succeeded"` with that value as
      // the run's result and asks nothing about where it came from. The final record was a verdict standing
      // in for the execution it was a verdict about.
      //
      // Skipped rather than treated as absent or unknown: this handle says nothing about whether the AGENT's
      // half is recoverable, and the verifier's own row settles on its own path. Falling through to the
      // no-adoption path is the honest answer — the agent's evidence is gone, so the run re-drives or
      // tombstones under its own fence, which is what it already does when nothing adopts.
      if (decision.kind === "adopted" && decision.adopted.stage === "case") {
        adopted = decision.adopted.result;
        adoptedFrom = work;
        break;
      }
      // ── A RECOVERED VERDICT IS MERGED, NOT DISCARDED (arch-review 60 follow-through) ────────────
      //
      // arch-review 60 stopped a verifier's verdict being settled AS the run's result — a verdict standing in
      // for the execution it was about — and could only SKIP it, because the agent's half lived in the dead
      // process's memory and there was nothing to merge into. `withVerifierPass` stages that half before it
      // dispatches the second container, so there is now.
      //
      // The merge is the SAME function the in-line path uses: a case recovered after a crash must be the same
      // document as one that finished normally, and both are `CaseResult`s, so any difference would be
      // invisible (rule `protocol` L5 — one wrapper, request path and reconciler).
      if (decision.kind === "adopted" && decision.adopted.stage === "verifier") {
        // ONE lookup protocol, shared with the batch planner (arch-review 62 P1): reaching the merge was
        // spelled here and nowhere else, so the other recovery owner discarded completed verifier work and
        // re-drove the case at full cost. The handle names WHICH physical half this verdict is about —
        // `workspaceDigest` is the tree, which two attempts of one case can share.
        const half = await recoverVerifiedCase(
          deps.agentHalves,
          r.tenant,
          `evd-run-${r.id}`,
          work,
          decision.adopted.invocation,
        );
        // A store that would not answer is not a case with no agent half. Deciding either way from a failed
        // read is how this became a settled verdict in the first place (rule `protocol` L2).
        if (half.kind === "unknown") return { kind: "retry_later", reason: half.reason };
        if (half.kind === "merged") {
          adopted = half.result;
          // The VERIFIER's row, which is the one this handle names — the agent's was committed before its
          // half was staged, so the two halves close on their own rows rather than one standing for both.
          adoptedFrom = work;
          break;
        }
        // `absent` — nothing was staged (an older writer, no artifact store, a staging failure). The agent's
        // evidence is genuinely gone, so this falls through to the no-adoption path exactly as before: the
        // run re-drives or tombstones under its own fence, which is the honest answer.
      }
      if (decision.kind === "unknown") return { kind: "retry_later", reason: decision.reason };
    }
  }
  // No handle = nothing this system can name, so nothing to adopt. `service.resume` then re-dispatches
  // (safe for the dispatch that died before reserving, which is the only way a post-Wave-A row gets
  // here) or tombstones under its own fence. What it no longer does is harvest "the newest job of this
  // case", which could be another run's.
  // A resume that THREW told us nothing — which is `retry_later`, not `unresumable` (arch-review 55,
  // rule `protocol` L2). Mapping it to the permanent case is how "the store hiccuped" became
  // "this run failed", and the sweep wrote a tombstone on the strength of it.
  const outcome = await service.resume(r, adopted, authority, adoptedFrom?.attemptId).catch(
    (err: unknown): ResumeResult => ({
      kind: "retry_later",
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
  // …and the attempt is closed BY that settlement, not after it (arch-review 63 P1-high). Stamping here was
  // refused every single time: `committed` requires the parent to be open and a successful resume closes it,
  // so the previous version of this line left every recovered attempt `reserved` — the defect arch-review 61
  // had closed. The stamp rides `settleRun` now, ordered inside the same decision.
  if (outcome.kind !== "unresumable") return outcome; // resumed, or already settled by whoever finished it
  // …and the TOMBSTONE IS THE SWEEP'S (arch-review 55). It used to be written here, inside a
  // fire-and-forget leg whose caller had already answered `true` — so the one place that knew the
  // outcome was also the one place nobody was waiting on. `recoverInterrupted` already tombstones an
  // `unresumable` disposition under the epoch it claimed; saying so once is the whole change.
  return { kind: "unresumable" };
}

export async function runStartupRecovery(deps: {
  scorecardStore: ScorecardStore;
  store: RunStore;
  // WHO we are + who else is alive (docs/architecture/multi-replica.md). Recovery reclaims a record only when
  // the replica that was driving it stopped heartbeating — a boot must never settle a living replica's work.
  owner: string;
  replicas: ReplicaRegistry;
  // Structural picks of the two services — recovery only ever calls resume, and the narrow surface is what
  // lets the tombstone-on-unresumable regression test drive this function without standing up a full service.
  scorecardService: Pick<ScorecardService, "resume">;
  service: Pick<RunService, "resume">;
  // The exact-work adopt and the ledger read that feeds it (arch-review 53, Wave B). Optional so a
  // composition that wires no attempt ledger keeps today's behavior — with the case-id resolution and its
  // documented blast radius, which is what the pre-handle rows have anyway.
  adoptWorkFn?: (tenant: string, runtimeList: string | undefined, work: RuntimeWorkRef) => Promise<AdoptionDecision>;
  workHandlesFor?: (executionId: string) => Promise<RuntimeWorkRef[]>;
}): Promise<RecoveryTarget[]> {
  const { scorecardStore, store, scorecardService, service, adoptWorkFn, workHandlesFor, owner, replicas } = deps;
  const recovered = await recoverInterrupted({
    scorecards: scorecardStore,
    runs: store,
    owner,
    replicas,
    // The claim's own answer travels with the call — recovery never asks the row what it is allowed to do.
    resume: (id, authority) => scorecardService.resume(id, authority),
    // Standalone runs: adopt the still-alive backend job first (zero re-run), else re-dispatch from the
    // persisted caseSpec (mig 0051); legacy records without one keep the tombstone path.
    // Claim the run for resume and adopt IN THE BACKGROUND — adopting a still-running run waits for its alloc to
    // finish (a long run would otherwise block control-plane startup). The background task settles via adoption
    // (zero re-run) or falls back to caseSpec re-dispatch. Returning true keeps recovery from tombstoning it —
    // which makes the CLAIM binding: a background leg that can neither adopt nor re-dispatch must apply the
    // tombstone itself, or the record it claimed stays `running` forever with nobody left to settle it.
    //
    // THE TOMBSTONE IS THE UNRESUMABLE BRANCH, NOT THE NOT-RESUMED BRANCH (arch-review 31 P0). This leg used
    // to settle whenever `resume` came back falsy, through a RAW store write with no CAS — so a run that
    // SUCCEEDED between the claim and the adoption (the ordinary case: adopting waits for the alloc to
    // finish) was recorded as an infrastructure failure. Two things were wrong and both are fixed: the
    // service now says WHICH of the two happened, and the write goes through `settleRun`, which cannot be
    // called without the terminal fence.
    // ONE function, called by boot AND by the periodic sweep — see `recoverStandaloneRun`.
    resumeRun: (r, authority) => recoverStandaloneRun(deps, r, authority),
  });
  if (recovered.scorecards + recovered.resumed + recovered.runs + recovered.runsResumed + recovered.sessions > 0)
    console.error(
      `▶ boot recovery: batches resumed ${recovered.resumed} · batches failed(INTERRUPTED) ${recovered.scorecards} · runs resumed ${recovered.runsResumed} · runs failed ${recovered.runs} · session runs left to their reapers ${recovered.sessions}`,
    );
  // Announced separately: "we found in-flight work and deliberately did NOT touch it" is the line an operator
  // needs when a replica boots into a running fleet.
  if (recovered.live > 0)
    console.error(`▶ boot recovery: left ${recovered.live} record(s) alone — another live replica is driving them`);
  // …AND WHAT IT STILL OWES (arch-review 56, Wave C). A deferred record is claimed by THIS replica, open, and
  // fenced at a raised epoch — which every other replica correctly reads as "somebody is driving this". The
  // caller registers `sweepDeferredRecovery` over this list; without it the record has an owner, a fence and
  // no driver until the process restarts, which is what the deferral's own comment assumed somebody was
  // already doing.
  if (recovered.owed.length > 0)
    console.error(
      `▶ boot recovery: ${recovered.owed.length} record(s) deferred — retried by this replica until they decide`,
    );
  return recovered.owed;
}

// ── THE WORKLIST IS A STATE, AND A TIMER IS NOT ALLOWED TO FORK IT (arch-review 58 P1) ──────────────
//
// The sweep below was registered as `setInterval(() => void (async () => { owed = await sweep(owed) })())`,
// which forks the moment one pass outlives the interval — and a pass RESUMES BATCHES, so outliving 60s is
// the ordinary case rather than the pathological one. Two consequences, both silent:
//
//   · two ticks call `resume` for the same target concurrently, which is the re-dispatch of live work this
//     whole file is written to avoid;
//   · the second tick started from the PRE-tick list, so whatever the first discharged is written back when
//     the second finishes — a lost update that keeps a settled debt owed forever.
//
// A boolean is enough, but it has to live with the list rather than beside the timer: the two are one state.
// Holding them in an object also gives the property somewhere to be tested, which a closure inside `main.ts`
// did not have.
// How many passes may fail to decide a target before it stops being ordinary. Counted in ATTEMPTS, not
// ticks, because the retries are now spaced: with the doubling schedule below, a fifth undecided attempt is
// about eight minutes in — long enough that a blinking ledger never pages anyone, short enough that a stuck
// one is named while somebody could still act on it. Ten attempts would be two hours under that schedule,
// which is a report rather than an alert.
const ESCALATE_AFTER_ATTEMPTS = 5;

// How many ticks between retries of a target that has deferred this many times: 1, 1, 2, 4, 8, 16, 32 —
// capped, so a stuck target is still asked about roughly every half hour on a 60-second timer. See `tick`.
function retryEvery(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 32);
}

export class DeferredRecoverySweep {
  private running = false;
  // The sweep's own timer is the clock, so the retry schedule is a count of ticks rather than a wall time.
  private ticks = 0;
  constructor(
    private readonly deps: Parameters<typeof runStartupRecovery>[0],
    private owed: readonly RecoveryTarget[],
  ) {}

  // What is still owed. Read by tests and by anything that wants to report the debt.
  get outstanding(): readonly RecoveryTarget[] {
    return this.owed;
  }

  // One pass, or nothing. A tick that arrives while a pass is running is DROPPED, not queued: the next one
  // is 60 seconds away and it will read the list the running pass leaves behind, which is the answer a queued
  // tick would have had to wait for anyway.
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ticks += 1;
    try {
      // ── A DEBT THAT KEEPS DEFERRING IS ASKED ABOUT LESS OFTEN ────────────────────────────────
      //
      // Every tick used to retry EVERY owed target. That is right for the case the worklist exists for — a
      // ledger blinked, the next minute decides it — and wrong for the case it converges to: an outage that
      // lasts, with N targets, is N store reads a minute forever, against the store that is already the
      // thing failing. The retry then adds load to the outage it is waiting out.
      //
      // So the attempt count that already rides each target is what schedules it: doubling, capped, so a
      // fresh deferral is retried immediately and a stuck one is asked about roughly every half hour. It
      // never STOPS being asked — starvation would turn a transient hold into a silent tombstone, which is
      // the failure this whole union exists to prevent.
      //
      // Tick-based rather than clock-based on purpose: the sweep's own timer is the clock, so the schedule
      // is deterministic and testable without a fake clock. It is not the DURABLE `nextAttemptAt` a restart
      // would preserve — a restart re-derives the worklist from the boot pass anyway.
      const due = this.owed.filter((t) => this.ticks % retryEvery(t.attempts) === 0);
      const waiting = this.owed.filter((t) => this.ticks % retryEvery(t.attempts) !== 0);
      this.owed = [...waiting, ...(await sweepDeferredRecovery(this.deps, due).catch(() => due))];
      // ── A DEBT THAT WILL NOT DECIDE IS AN ESCALATION, NOT A QUIET HOLD (arch-review 58, W4) ────
      //
      // `retry_later` always carried a REASON — "the attempt ledger would not answer", "the cluster did not
      // say whether the job is live" — and every consumer dropped the string. So a target could sit here
      // forever with nothing anywhere saying why, which is the state rule `protocol` L5 names: "we could not
      // find out" is an escalation field (attempts, backoff, operator alert), never a silence.
      //
      // A first deferral is ordinary — a ledger blinked, the next tick decides it. A target that has failed
      // to decide this many times is somebody's problem, and it says which target and what the last pass
      // actually saw, so the operator starts from the answer rather than from a count.
      for (const t of this.owed)
        if (t.attempts >= ESCALATE_AFTER_ATTEMPTS)
          console.error(
            `▶ recovery: ${t.kind} ${t.id} has been undecidable for ${t.attempts} passes — ${t.lastReason ?? "no reason recorded"}`,
          );
    } finally {
      this.running = false;
    }
  }
}

// The retry the deferral always assumed, wired to the same services boot recovery used. Returns what is STILL
// owed, so the caller feeds its own answer back in and a persistent outage keeps the debt visible instead of
// resolving it. Never `runStartupRecovery` on a timer — see `retryDeferredRecovery`.
export async function sweepDeferredRecovery(
  deps: Parameters<typeof runStartupRecovery>[0],
  owed: readonly RecoveryTarget[],
): Promise<RecoveryTarget[]> {
  if (owed.length === 0) return [];
  return await retryDeferredRecovery(
    {
      scorecards: deps.scorecardStore,
      runs: deps.store,
      owner: deps.owner,
      resume: (id, authority) => deps.scorecardService.resume(id, authority),
      // THE SAME transition boot runs, not its last line (arch-review 59 P0-lifecycle). Wiring this to
      // `service.resume(r, undefined, …)` meant a run deferred because the cluster would not say whether its
      // job was live came back and skipped the question, re-dispatching compute that was still running.
      resumeRun: (r, authority) => recoverStandaloneRun(deps, r, authority),
    },
    owed,
  );
}
