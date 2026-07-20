import { type AgentJob, AgentJobSchema, type CaseResult, RUNNER_PROTOCOL_VERSION } from "@everdict/contracts";
import { classifyFailure, stageForError } from "@everdict/domain";

// Dependencies of the runner lease worker pool — the caller (main.ts) absorbs transport/session via ResilientMcpSession,
// and here we inject only callJson (already JSON-parsed and retried) and job execution, keeping just the pure lease-loop logic (test-friendly).
export interface RunnerLoopDeps {
  // MCP tool call → JSON result. App-level errors (isError) surface as a throw (the caller wrapper's contract).
  callJson: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // Run a leased job (service→Docker topology / otherwise→LocalDriver). The caller closes over runtimeOptions etc.
  // signal aborts the run when the control plane cancels this job (heartbeat-delivered) — the run tears down its
  // compute/topology and frees the runtime mid-case. reportScreen (when the harness declares liveScreen) pushes each
  // captured frame of the case's screen back to the control plane for live viewing.
  runJob: (
    job: AgentJob,
    opts?: { signal?: AbortSignal; reportScreen?: (frameBase64: string) => Promise<void> },
  ) => Promise<CaseResult>;
  log?: (msg: string) => void; // default no-op (tests stay quiet)
  sleep?: (ms: number) => Promise<void>; // default setTimeout
  // Hook that sets up lease renewal while running — returns a cleanup function. Default is setInterval(heartbeat_job).
  // onCancel fires when the control plane's heartbeat response asks to stop this job (→ abort the local run). Tests inject a fake.
  setHeartbeat?: (jobId: string, onCancel: () => void) => () => void;
  // Fired (at most once per run) when the control plane reports this runner is older than the server (lease reply
  // updateRequired:true) — the seam the desktop wires to force an immediate auto-update check. GUI-free: the core only signals.
  onUpdateRequired?: (info: { serverProtocol?: number }) => void;
}

export interface RunnerLoopOpts {
  maxConcurrent: number; // Number of concurrent workers (= concurrent leases). The knob by which one runner process achieves case-level parallelism.
  waitMs: number; // lease long-poll wait (holds until the server has a job)
  heartbeatMs: number; // lease renewal interval while running
  pollMs: number; // lease error backoff
  capabilities: string[]; // self-advertised on every lease (repo/docker/browser)
  os?: string; // this machine's platform (process.platform), self-reported on every lease → the roster fills in the OS with no user input
  version?: string; // runner build/app version, self-reported on every lease (display only; the protocol drives update-required)
  shouldStop: () => boolean; // stop via SIGINT etc. — a worker drops out after finishing its current job
}

// Runs maxConcurrent worker loops concurrently. Each worker independently repeats lease_job → runJob → submit_job_result.
// RunnerHub.lease is single-threaded atomic (no interleaving during synchronous execution), so concurrent lease_job calls
// never take the same job twice → workers safely pick different cases and run one batch in parallel.
// Design: docs/architecture/self-hosted-runner.md.
export async function runLeaseWorkers(deps: RunnerLoopDeps, opts: RunnerLoopOpts): Promise<void> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setHeartbeat =
    deps.setHeartbeat ??
    ((jobId: string, onCancel: () => void) => {
      const t = setInterval(() => {
        void deps
          // Carry capabilities on the heartbeat too — the hub only keeps QUEUED jobs alive that this runner could
          // run, so a job whose only capable runner died stops being refreshed by incapable survivors (no eternal pending).
          .callJson("heartbeat_job", { jobId, ...(opts.capabilities ? { capabilities: opts.capabilities } : {}) })
          .then((r) => {
            // The control plane piggybacks a cancel decision on the liveness reply — stop the local run on request.
            if (r.cancelled === true) onCancel();
          })
          .catch(() => {});
      }, opts.heartbeatMs);
      (t as { unref?: () => void }).unref?.();
      return () => clearInterval(t);
    });
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // The control plane sets updateRequired on the lease reply when this runner is behind the server. Fire the seam ONCE
  // for the whole pool (every worker's lease sees it) — the desktop acts on it (force an update check); repeating it each
  // poll would spam. Reset per runLeaseWorkers call (a fresh session after a restart re-evaluates).
  let updateSignalled = false;
  const noteUpdate = (leased: Record<string, unknown>): void => {
    if (updateSignalled || leased.updateRequired !== true) return;
    updateSignalled = true;
    const serverProtocol = typeof leased.serverProtocol === "number" ? leased.serverProtocol : undefined;
    log("⚠ this runner is older than the control plane — an update is required.");
    deps.onUpdateRequired?.({ ...(serverProtocol !== undefined ? { serverProtocol } : {}) });
  };

  const worker = async (): Promise<void> => {
    while (!opts.shouldStop()) {
      let leased: Record<string, unknown>;
      try {
        leased = await deps.callJson("lease_job", {
          wait_ms: opts.waitMs,
          capabilities: opts.capabilities,
          ...(opts.os !== undefined ? { os: opts.os } : {}),
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          protocol: RUNNER_PROTOCOL_VERSION,
        });
      } catch (e) {
        log(`✗ lease failed: ${errMsg(e)}`);
        await sleep(opts.pollMs);
        continue;
      }
      noteUpdate(leased); // an out-of-date runner is told to update (piggybacked on the lease reply)
      if (!leased.job) {
        await sleep(250); // long-poll timeout (no job) — repoll immediately (the server is already waiting)
        continue;
      }
      const jobId = String(leased.jobId);
      const parsed = AgentJobSchema.safeParse(leased.job); // boundary validation
      if (!parsed.success) {
        // A discriminator/enum mismatch on the embedded harnessSpec (e.g. target.delivery.mode) almost always means
        // this self-hosted runner and the control plane are on different everdict versions — the job schema was
        // tightened on one side. Say so, otherwise a bare "malformed job" can't be told apart from a genuinely bad
        // spec and the user has no next step. (Any harnessSpec-scoped issue is treated the same way.)
        const versionSkew = parsed.error.issues.some(
          (i) => i.code === "invalid_union_discriminator" || i.path[0] === "harnessSpec",
        );
        const hint = versionSkew
          ? " — this usually means the runner and the control plane are on different everdict versions; update the self-hosted runner (or re-pin the harness) so both match"
          : "";
        log(`✗ job ${jobId} malformed → replying fail`);
        await deps
          .callJson("fail_job", { jobId, message: `malformed job: ${parsed.error.message}${hint}` })
          .catch(() => {});
        continue;
      }
      log(`▶ running job ${jobId} (case ${parsed.data.evalCase.id}) …`);
      // Cancellation: the control plane signals a stop via the heartbeat reply → abort the run (its compute/topology
      // is torn down, freeing the runtime mid-case). The run then throws and the classified-failure path replies.
      const controller = new AbortController();
      // Renew the lease via periodic heartbeat so a long-running job isn't requeued by the server.
      const stopHeartbeat = setHeartbeat(jobId, () => controller.abort());
      // Live-screen frames: push each captured frame to the control plane keyed by the CP-minted runId. Only wired when
      // the job carries a runId (control-plane dispatch); runJob only calls it when the harness declares liveScreen.
      const runId = parsed.data.runId;
      const reportScreen = runId
        ? (frame: string): Promise<void> => deps.callJson("report_case_screen", { runId, frame }).then(() => {})
        : undefined;
      try {
        const result = await deps.runJob(parsed.data, {
          signal: controller.signal,
          ...(reportScreen ? { reportScreen } : {}),
        });
        await deps.callJson("submit_job_result", { jobId, result });
        log(`✓ job ${jobId} done → replied`);
      } catch (e) {
        // Classified failure parity with the agent sentinel: the self-hosted path has no sentinel, so a bare
        // fail_job would erase WHERE the case died. Submit a classified failed CaseResult instead (the batch
        // settles it with stage/class intact); fail_job stays only for jobs we cannot even parse.
        const failure = classifyFailure(e, stageForError(e));
        log(`✗ job ${jobId} failed [${failure.class}/${failure.stage}]: ${errMsg(e)} → replying classified result`);
        const failed = {
          caseId: parsed.data.evalCase.id,
          harness: `${parsed.data.harness.id}@${parsed.data.harness.version}`,
          trace: [{ t: 0, kind: "error", message: errMsg(e) }],
          snapshot: { kind: "prompt", output: "" },
          scores: [
            {
              graderId: failure.stage,
              metric: "error",
              value: 0,
              pass: false,
              detail: `[${failure.class}] ${errMsg(e)}`,
            },
          ],
          failure,
        };
        await deps.callJson("submit_job_result", { jobId, result: failed }).catch(async () => {
          await deps.callJson("fail_job", { jobId, message: errMsg(e) }).catch(() => {});
        });
      } finally {
        stopHeartbeat();
      }
    }
  };

  // Worker pool — all share the same session (callJson) (MCP allows concurrent calls). They drop out together via shouldStop.
  await Promise.all(Array.from({ length: Math.max(1, opts.maxConcurrent) }, () => worker()));
}
