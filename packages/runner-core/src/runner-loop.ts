import { type AgentJob, AgentJobSchema, type CaseResult } from "@everdict/core";

// Dependencies of the runner lease worker pool — the caller (main.ts) absorbs transport/session via ResilientMcpSession,
// and here we inject only callJson (already JSON-parsed and retried) and job execution, keeping just the pure lease-loop logic (test-friendly).
export interface RunnerLoopDeps {
  // MCP tool call → JSON result. App-level errors (isError) surface as a throw (the caller wrapper's contract).
  callJson: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // Run a leased job (service→Docker topology / otherwise→LocalDriver). The caller closes over runtimeOptions etc.
  runJob: (job: AgentJob) => Promise<CaseResult>;
  log?: (msg: string) => void; // default no-op (tests stay quiet)
  sleep?: (ms: number) => Promise<void>; // default setTimeout
  // Hook that sets up lease renewal while running — returns a cleanup function. Default is setInterval(heartbeat_job). Tests inject a fake.
  setHeartbeat?: (jobId: string) => () => void;
}

export interface RunnerLoopOpts {
  maxConcurrent: number; // Number of concurrent workers (= concurrent leases). The knob by which one runner process achieves case-level parallelism.
  waitMs: number; // lease long-poll wait (holds until the server has a job)
  heartbeatMs: number; // lease renewal interval while running
  pollMs: number; // lease error backoff
  capabilities: string[]; // self-advertised on every lease (repo/docker/browser)
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
    ((jobId: string) => {
      const t = setInterval(() => {
        void deps.callJson("heartbeat_job", { jobId }).catch(() => {});
      }, opts.heartbeatMs);
      (t as { unref?: () => void }).unref?.();
      return () => clearInterval(t);
    });
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const worker = async (): Promise<void> => {
    while (!opts.shouldStop()) {
      let leased: Record<string, unknown>;
      try {
        leased = await deps.callJson("lease_job", { wait_ms: opts.waitMs, capabilities: opts.capabilities });
      } catch (e) {
        log(`✗ lease failed: ${errMsg(e)}`);
        await sleep(opts.pollMs);
        continue;
      }
      if (!leased.job) {
        await sleep(250); // long-poll timeout (no job) — repoll immediately (the server is already waiting)
        continue;
      }
      const jobId = String(leased.jobId);
      const parsed = AgentJobSchema.safeParse(leased.job); // boundary validation
      if (!parsed.success) {
        log(`✗ job ${jobId} malformed → replying fail`);
        await deps.callJson("fail_job", { jobId, message: `malformed job: ${parsed.error.message}` }).catch(() => {});
        continue;
      }
      log(`▶ running job ${jobId} (case ${parsed.data.evalCase.id}) …`);
      // Renew the lease via periodic heartbeat so a long-running job isn't requeued by the server.
      const stopHeartbeat = setHeartbeat(jobId);
      try {
        const result = await deps.runJob(parsed.data);
        await deps.callJson("submit_job_result", { jobId, result });
        log(`✓ job ${jobId} done → replied`);
      } catch (e) {
        log(`✗ job ${jobId} failed: ${errMsg(e)} → replying fail`);
        await deps.callJson("fail_job", { jobId, message: errMsg(e) }).catch(() => {});
      } finally {
        stopHeartbeat();
      }
    }
  };

  // Worker pool — all share the same session (callJson) (MCP allows concurrent calls). They drop out together via shouldStop.
  await Promise.all(Array.from({ length: Math.max(1, opts.maxConcurrent) }, () => worker()));
}
