import { recoverInterrupted } from "@everdict/application-control";
import type { RunService } from "@everdict/application-control";
import type { ScorecardService } from "@everdict/application-control";
import { type Backend, isObservable, isRecoverable, isScreenCapturable, isShellable } from "@everdict/backends";
import type { CaseResult, RegistryAuth, RuntimeSpec } from "@everdict/contracts";
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
    opts: { secretEnv?: Record<string, string>; registryAuth?: RegistryAuth },
  ) => Backend;
}) {
  const { runtimeRegistry, runtimeSecretsFor, runtimeBuildBackend } = deps;
  // Boot-recovery adoption + supersede force-kill: resolve each runtime of the child's recorded lane (may be a
  // comma shard list) to a live backend and use its optional adopt/kill. Best-effort by design — a miss falls
  // back to re-dispatch (adopt) or leaves the job to finish unobserved (kill).
  const eachRuntimeBackend = async (
    tenant: string,
    runtimeList: string | undefined,
    fn: (backend: Backend) => Promise<boolean>, // return true to stop iterating (handled)
  ): Promise<void> => {
    const targets = (runtimeList ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "" && !t.startsWith("self:")); // self-hosted lanes are lease queues — nothing to adopt/kill
    for (const target of targets) {
      const spec = await runtimeRegistry.get(tenant, target).catch(() => undefined);
      if (!spec) continue;
      const secretEnv = await runtimeSecretsFor(tenant).catch(() => ({}) as Record<string, string>);
      const backend = runtimeBuildBackend(spec, { secretEnv });
      if (await fn(backend)) return;
    }
  };

  // Adopt a still-alive backend job's finished result by caseId — shared by scorecard resume and
  // standalone-run boot recovery (P4 single-run durability): zero re-run when the job outlived the CP restart.
  const adoptCaseFn = async (
    tenant: string,
    runtimeList: string | undefined, // may be a comma shard list — eachRuntimeBackend splits it
    caseId: string,
  ): Promise<CaseResult | undefined> => {
    let adopted: CaseResult | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isRecoverable(backend)) return false;
      const outcome = await backend.adopt(caseId); // total (never throws) — no redundant .catch here
      if (outcome.status === "adopted") {
        adopted = outcome.result;
        return true; // harvested a finished job — stop scanning lanes
      }
      if (outcome.status === "unknown") {
        // The job may still be live but we couldn't confirm — surface that re-dispatch might double-spend compute.
        console.warn(
          `▶ adopt: inconclusive for case ${caseId} (tenant ${tenant}) — re-dispatch may double-spend a live job`,
        );
      }
      return false; // absent or unknown → try the next runtime lane, then fall back to re-dispatch
    });
    return adopted;
  };

  // Live-progress log read — same lane resolution as adoption; the first backend with a readable log wins.
  const readCaseLogsFn = async (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
  ): Promise<string | undefined> => {
    let text: string | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isObservable(backend)) return false;
      text = await backend.logs(caseId).catch(() => undefined);
      return text !== undefined;
    });
    return text;
  };

  // Open an interactive shell stream on a case's live sandbox (observability ⑥) — same lane resolution as logs.
  const openTerminalStreamFn = async (tenant: string, runtimeList: string | undefined, caseId: string) => {
    let handle: import("@everdict/backends").ExecStreamHandle | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isShellable(backend)) return false;
      handle = await backend.execStream(caseId).catch(() => undefined);
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

  // One-shot exec into a case's live sandbox (web terminal / live screen) — same lane resolution as logs.
  const execInSandboxFn = async (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> => {
    let out: { stdout: string; stderr: string; exitCode: number } | undefined;
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isObservable(backend)) return false;
      out = await backend.exec(caseId, command).catch(() => undefined);
      return out !== undefined;
    });
    return out;
  };

  // Supersede / speculation-loser force-kill of an in-flight case — every runtime of the shard list gets the kill
  // (the case may live on any of them), so this never stops early (each fn returns false). Best-effort.
  const killCase = async (tenant: string, runtimeList: string | undefined, caseId: string): Promise<void> => {
    await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
      if (!isRecoverable(backend)) return false;
      await backend.kill(caseId).catch(() => {});
      return false; // every runtime of the shard list gets the kill (the case may live on any of them)
    });
  };
  return {
    eachRuntimeBackend,
    adoptCaseFn,
    readCaseLogsFn,
    openTerminalStreamFn,
    captureBrowserScreenFn,
    execInSandboxFn,
    killCase,
  };
}

// Recover orphaned jobs at boot — batches/runs are tracked in-process within this process, so at restart any
// queued/running record is a ghost with no one to resume it. Interrupted BATCHES are resumed from their finished
// child results (unfinished cases re-dispatched); unresumable records fall back to failed(INTERRUPTED).
// docs/architecture/batch-resilience.md
export async function runStartupRecovery(deps: {
  scorecardStore: ScorecardStore;
  store: RunStore;
  scorecardService: ScorecardService;
  service: RunService;
  adoptCaseFn: (tenant: string, runtimeList: string | undefined, caseId: string) => Promise<CaseResult | undefined>;
}): Promise<void> {
  const { scorecardStore, store, scorecardService, service, adoptCaseFn } = deps;
  const recovered = await recoverInterrupted({
    scorecards: scorecardStore,
    runs: store,
    resume: (id) => scorecardService.resume(id),
    // Standalone runs: adopt the still-alive backend job first (zero re-run), else re-dispatch from the
    // persisted caseSpec (mig 0051); legacy records without one keep the tombstone path.
    // Claim the run for resume and adopt IN THE BACKGROUND — adopting a still-running run waits for its alloc to
    // finish (a long run would otherwise block control-plane startup). The background task settles via adoption
    // (zero re-run) or falls back to caseSpec re-dispatch. Returning true keeps recovery from tombstoning it.
    resumeRun: async (r) => {
      void (async () => {
        const adopted = await adoptCaseFn(r.tenant, r.runtime, r.caseId).catch(() => undefined);
        await service.resume(r, adopted).catch(() => {});
      })();
      return true;
    },
  });
  if (recovered.scorecards + recovered.resumed + recovered.runs + recovered.runsResumed > 0)
    console.error(
      `▶ boot recovery: batches resumed ${recovered.resumed} · batches failed(INTERRUPTED) ${recovered.scorecards} · runs resumed ${recovered.runsResumed} · runs failed ${recovered.runs}`,
    );
}
