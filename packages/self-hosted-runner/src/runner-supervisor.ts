import { type RunnerLoopDeps, type RunnerLoopOpts, runLeaseWorkers } from "./runner-loop.js";

// Watchdog options for the lease supervisor.
export interface SuperviseOpts {
  restartMs?: number; // backoff before restarting a pool that ended unexpectedly (default 2s)
  log?: (msg: string) => void; // default deps.log
  sleep?: (ms: number) => Promise<void>; // default deps.sleep / setTimeout
  // Injection point for tests (and the one seam the supervisor supervises) — defaults to the real worker pool.
  runPool?: (deps: RunnerLoopDeps, opts: RunnerLoopOpts) => Promise<void>;
  // Fires on each restart (#n) — for status/telemetry (the desktop surfaces "reconnecting"). Optional.
  onRestart?: (attempt: number) => void;
}

// Perpetual supervisor over the lease worker pool — the runner should keep working until shouldStop().
//
// Session/network blips already self-heal INSIDE the loop (ResilientMcpSession re-initializes a dead MCP session and
// per-lease errors back off and retry), and a single failed job is submitted as a classified result — the worker keeps
// going. What was NOT covered: if the whole pool ever terminates for an unforeseen reason (an unexpected throw escaping a
// worker, so Promise.all rejects), the runner went silently dead with no way back short of a manual restart. This wraps
// the pool so any such termination is caught, logged, and the pool is restarted after a backoff — the runner self-heals.
// Only a real stop (shouldStop() — SIGINT / RunnerHost.stop()) ends the supervisor. Design: docs/architecture/self-hosted-runner.md.
export async function superviseLease(
  deps: RunnerLoopDeps,
  opts: RunnerLoopOpts,
  sup: SuperviseOpts = {},
): Promise<void> {
  const log = sup.log ?? deps.log ?? (() => {});
  const sleep = sup.sleep ?? deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runPool = sup.runPool ?? runLeaseWorkers;
  const restartMs = sup.restartMs ?? 2_000;
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let restarts = 0;
  while (!opts.shouldStop()) {
    try {
      await runPool(deps, opts); // returns only when shouldStop() (workers drain out) — or throws on an unforeseen crash
    } catch (e) {
      log(`✗ runner lease pool crashed: ${errMsg(e)}`);
    }
    if (opts.shouldStop()) break; // a clean, user-requested stop — do not restart
    restarts++;
    sup.onRestart?.(restarts);
    log(`runner lease pool ended unexpectedly — restarting (#${restarts}) in ${restartMs}ms (self-heal)`);
    await sleep(restartMs);
  }
}
