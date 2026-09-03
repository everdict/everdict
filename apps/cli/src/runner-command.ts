import { hasClaudeAuth } from "@everdict/job-runner";
import {
  ResilientMcpSession,
  detectCapabilities,
  mcpConnect,
  runLeasedJob,
  superviseLease,
} from "@everdict/self-hosted-runner";
import type { DockerTopologyRuntimeOptions } from "@everdict/topology";
import { loginMountsFor } from "./login-mounts.js";

// `everdict runner` — the self-hosted runner lease loop, extracted from main.ts so it can be bundled into a STANDALONE
// binary (`runner-standalone.ts`) WITHOUT pulling in @everdict/orchestrator (Temporal's native Rust bindings can't be
// bundled). The runner path only needs @everdict/self-hosted-runner + @everdict/job-runner, both of which bundle cleanly
// (the desktop already bundles the same). Runner LOGIC lives in @everdict/self-hosted-runner — this stays a thin wrapper.
// Design: docs/architecture/self-hosted-runner.md · docs/architecture/runner-distribution.md.
export async function runnerCommand(flags: Map<string, string>): Promise<void> {
  const token = flags.get("pair") ?? process.env.EVERDICT_RUNNER_TOKEN;
  if (!token || !token.startsWith("rnr_")) {
    console.error("✗ --pair <rnr_…> (or EVERDICT_RUNNER_TOKEN) is required — pair a device on the account page.");
    process.exitCode = 1;
    return;
  }
  const apiUrl = flags.get("api-url") ?? process.env.EVERDICT_API_URL ?? "http://localhost:8787";
  const mcpUrl = new URL("/mcp", apiUrl);
  const pollMs = Number(flags.get("poll-interval-ms") ?? "2000"); // error-retry backoff
  const waitMs = Number(flags.get("wait-ms") ?? "25000"); // lease long-poll wait (server holds until a job appears)
  const hbMs = Number(flags.get("heartbeat-ms") ?? "30000"); // lease-renewal interval while running
  // Number of lease workers to run concurrently — the knob by which one runner achieves case-level parallelism. Default 1 (preserves the current serial behavior).
  // Submitting a scorecard with concurrency=N parks N jobs, and only this many run at once (actual parallelism = min(N, this value)).
  const maxConcurrent = Math.max(1, Number(flags.get("max-concurrent") ?? "1"));
  // service(topology) harness readiness polling ceiling — the runtime default when a service spec does not declare its own readiness.
  const runtimeOptions: DockerTopologyRuntimeOptions = {};
  if (flags.has("ready-timeout-ms")) runtimeOptions.readyTimeoutMs = Number(flags.get("ready-timeout-ms"));
  if (flags.has("ready-interval-ms")) runtimeOptions.pollIntervalMs = Number(flags.get("ready-interval-ms"));
  if (!hasClaudeAuth()) {
    console.error(
      "ℹ No claude auth in this machine's env — claude-code jobs use this machine's login (may fail if absent).",
    );
  }

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  // Real capability self-advertisement: if the docker daemon is present, docker/browser (service harnesses possible). Reported on every lease.
  const capabilities = await detectCapabilities();
  const dockerOk = capabilities.includes("docker");

  // The machine logins this runner is willing to lend a containerized job. One decision per agent CLI, in
  // `login-mounts.ts` so it is testable — the loop around it is not.
  const { mounts, notes } = loginMountsFor(new Set(flags.keys()), { dockerOk });
  for (const note of notes) console.error(note);

  // wedge prevention: a resilient MCP session (@everdict/self-hosted-runner) that auto-reinitializes on API restart/disconnect. Lazy connect.
  const session = new ResilientMcpSession(mcpConnect(mcpUrl, token));
  try {
    await session.ensureConnected();
    console.error(
      `▶ everdict runner — connected to ${mcpUrl}. capabilities: ${capabilities.join(", ")}${dockerOk ? "" : " (no docker → service harnesses unavailable)"}. Polling for jobs with ${maxConcurrent} concurrent worker(s) (Ctrl-C to stop) …`,
    );
  } catch (e) {
    console.error(`⚠ Initial connection failed (${errMsg(e)}) — retrying while polling …`);
  }

  const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await session.call(name, args); // if the session died, it reinitializes internally and retries
    if (r.isError) throw new Error(r.text || `${name} failed`);
    return JSON.parse(r.text) as Record<string, unknown>;
  };

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.error("\n▶ Stop signal — stopping after the current job …");
  });

  // maxConcurrent workers share the same session and lease/run/report concurrently — one runner achieves case-level parallelism.
  // superviseLease restarts the pool if it ever ends unexpectedly (crash) so `everdict runner` self-heals until Ctrl-C.
  await superviseLease(
    {
      callJson,
      // service→Docker topology / image-case→local Docker (DockerDriver, dockerOk gate, host mounts) / else→host LocalDriver.
      // The worker's whole opts bag is forwarded verbatim (signal/reportScreen/recordSink/reportTrace/caseFs and
      // whatever the loop grows next) — the old field-picking silently DROPPED every hook it didn't name, which is
      // exactly how the workbench's caseFs servicing went dead on `everdict runner` (live-found in the S6 drill).
      runJob: (job, o) =>
        runLeasedJob(job, {
          runtimeOptions,
          dockerAvailable: dockerOk,
          mounts,
          log: (m) => console.error(m),
          ...o,
        }),
      log: (m) => console.error(m),
      sleep,
    },
    {
      maxConcurrent,
      waitMs,
      heartbeatMs: hbMs,
      pollMs,
      capabilities,
      os: process.platform, // self-reported OS → the workspace roster fills in the OS badge (registration only names the runner)
      // Optional display version (the protocol version — auto-sent from @everdict/contracts — drives update-required).
      ...(process.env.EVERDICT_RUNNER_VERSION ? { version: process.env.EVERDICT_RUNNER_VERSION } : {}),
      shouldStop: () => stop,
    },
  );
  await session.close();
}
