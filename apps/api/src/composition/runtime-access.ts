import { randomUUID } from "node:crypto";
import {
  type RecoveryTarget,
  type ReplicaRegistry,
  type ResumeResult,
  recoverInterrupted,
  retryDeferredRecovery,
  tombstoneInterrupted,
} from "@everdict/application-control";
import type { RunService } from "@everdict/application-control";
import type { ScorecardService } from "@everdict/application-control";
import {
  type Backend,
  type LogStream,
  isScreenAttachable,
  isScreenCapturable,
  isTopologyInspectable,
  isVerifierDispatchable,
  isWorkAddressable,
  isWorkControllable,
} from "@everdict/backends";
import type {
  AdoptionDecision,
  CaseResult,
  KillOutcome,
  ReadResult,
  RegistryAuth,
  RuntimeSpec,
  RuntimeWorkRef,
  Score,
  TraceEvent,
  VerifierJob,
  WorkPresence,
} from "@everdict/contracts";
import { NotFoundError, readOrUnknown, worstKillOutcome } from "@everdict/contracts";
import type { CasePlacement, TopologyStatus } from "@everdict/contracts/wire";
import type { RunStore, ScorecardStore } from "@everdict/db";
import type { RuntimeRegistry } from "@everdict/registry";

// Per-runtime backend access for already-dispatched cases: adoption/kill (boot recovery, supersede) + the
// live-observability reads (logs / one-shot exec / terminal stream / browser frame). Resolves the recorded
// runtime lane (possibly a comma shard list) to live backends via the shared runtime builder/auth path.
export function buildRuntimeAccess(deps: {
  runtimeRegistry: RuntimeRegistry;
  runtimeSecretsFor: (tenant: string) => Promise<Record<string, string>>;
  runtimeBuildBackend: (
    spec: RuntimeSpec,
    opts: { secretEnv?: Record<string, string>; registryAuths?: RegistryAuth[] },
  ) => Backend;
}) {
  const { runtimeRegistry, runtimeSecretsFor, runtimeBuildBackend } = deps;
  // Boot-recovery adoption + supersede force-kill: resolve each runtime of the child's recorded lane (may be a
  // comma shard list) to a live backend and use its optional adopt/kill. A LANE that cannot be resolved is
  // silent here by design (adoption falls back to re-dispatch); the KILL paths below no longer treat that
  // silence as success — see `killWork`/`killUnhandled`.
  const eachRuntimeBackend = async (
    tenant: string,
    runtimeList: string | undefined,
    fn: (backend: Backend) => Promise<boolean>, // return true to stop iterating (handled)
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
      if (await fn(backend)) return { unresolved };
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
    let harvested: CaseResult | undefined;
    let unresolved: string | undefined;
    const { unresolved: lanes } = await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isWorkControllable(backend)) return false;
      const outcome = await backend.adoptWork(work);
      if (outcome.status === "adopted") {
        harvested = outcome.result;
        return true;
      }
      if (outcome.status === "unknown") unresolved = "a runtime could not say whether this work is still live";
      return false;
    });
    if (harvested !== undefined) return { kind: "adopted", result: harvested };
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
  const dispatchVerifier = async (job: VerifierJob): Promise<Score[]> => {
    let scores: Score[] | undefined;
    await eachRuntimeBackend(job.tenant, undefined, async (backend) => {
      if (!isVerifierDispatchable(backend)) return false;
      scores = await backend.dispatchVerifier(job);
      return true; // the first lane that can judge is the answer
    });
    if (scores === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { caseId: job.caseId },
        "no runtime in this workspace can run a verifier away from the agent's container — the case cannot be judged here.",
      );
    return scores;
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
    resumeRun: async (r, authority) => {
      return await (async (): Promise<ResumeResult> => {
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
            if (decision.kind === "adopted") {
              adopted = decision.result;
              break;
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
        const outcome = await service.resume(r, adopted, authority).catch(
          (err: unknown): ResumeResult => ({
            kind: "retry_later",
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        if (outcome.kind !== "unresumable") return outcome; // resumed, or already settled by whoever finished it
        // …and the TOMBSTONE IS THE SWEEP'S (arch-review 55). It used to be written here, inside a
        // fire-and-forget leg whose caller had already answered `true` — so the one place that knew the
        // outcome was also the one place nobody was waiting on. `recoverInterrupted` already tombstones an
        // `unresumable` disposition under the epoch it claimed; saying so once is the whole change.
        return { kind: "unresumable" };
      })();
    },
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
      resumeRun: (r, authority) => deps.service.resume(r, undefined, authority),
    },
    owed,
  );
}
