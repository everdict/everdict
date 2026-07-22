import { type SelfHostedKey, runnerUpdateRequired } from "@everdict/application-control";
import { CaseResultSchema, RUNNER_PROTOCOL_VERSION } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain } from "../mcp-context.js";

// Runner-lease MCP tools — the runner protocol (lease/submit/fail/heartbeat) over the MCP transport.
export function registerRunnerLeaseTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal } = ctx;

  // Runner protocol — `everdict runner` calls this from its own machine (runner token rnr_ → via=runner, principal.runnerId).
  // It leases a job, runs it locally, and reports the result (submit/fail). Runner token only — regular credentials are rejected.
  if (deps.runnerHub) {
    const hub = deps.runnerHub;
    // (owner=subject, runnerId) — the same key the dispatcher parked the self: job under. runnerId comes from the token.
    // Workspace-agnostic: one runner takes jobs from every workspace its owner belongs to (cross-workspace).
    const runnerKey = (): SelfHostedKey | undefined =>
      principal.runnerId ? { owner: principal.subject, runnerId: principal.runnerId } : undefined;
    const NEED_RUNNER = "FORBIDDEN: runner credentials (rnr_ pairing token) required.";

    server.registerTool(
      "lease_job",
      {
        description:
          "Fetch the next eval job (runner pull, long-poll). If none, wait up to wait_ms then {job:null} — safe to call again immediately. Passing capabilities self-advertises the runner (e.g. docker detection → service-harness gate). Passing os self-reports the machine's platform (process.platform) → the roster fills in the OS with no user input. Passing version/protocol self-reports the runner build; if the runner's protocol is behind this control plane the reply carries updateRequired:true (the runner/desktop should update). Report the result via submit_job_result.",
        inputSchema: {
          wait_ms: z.number().int().min(0).max(60_000).optional(),
          capabilities: z.array(z.string()).optional(),
          os: z.string().max(40).optional(),
          version: z.string().max(80).optional(),
          protocol: z.number().int().optional(),
          // Live self-reported status/last-error for the roster's diagnosability (why it can/can't do work) — "idle",
          // "running 2 job(s)", "no Docker daemon", "image pull failed: …". Overlaid on the roster read, never persisted.
          status: z.string().max(200).optional(),
          statusLevel: z.enum(["info", "warn", "error"]).optional(),
        },
      },
      ({ wait_ms, capabilities, os, version, protocol, status, statusLevel }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) {
            await deps.runnerService.touch(key.owner, key.runnerId); // mark as connected
            // Update when the runner reports its actual capabilities (docker detection → sharpens the service-harness dispatch gate).
            if (capabilities) await deps.runnerService.setCapabilities(key.owner, key.runnerId, capabilities);
            // Self-reported OS (process.platform) → the roster's OS badge is filled at attach time; registration only names the runner.
            if (os) await deps.runnerService.setOs(key.owner, key.runnerId, os);
            // Persist the self-reported build/protocol version → drives the roster's update-required badge.
            if (version !== undefined && protocol !== undefined)
              await deps.runnerService.reportVersion(key.owner, key.runnerId, version, protocol);
            // Live status overlay (server-stamped time so a skewed runner clock can't backdate/expire it).
            if (status)
              deps.runnerService.reportStatus(key.runnerId, status, statusLevel ?? "info", new Date().toISOString());
          }
          // Pass capabilities to the hub → placement gate (if a case.image needs docker but the runner lacks it, reject that job outright).
          const leased = await hub.leaseWait(key, wait_ms ?? 0, capabilities); // unset = return immediately (backward compatible)
          // A runner older than this control plane is told to update (piggybacked on the lease reply — the runner acts on it,
          // e.g. the desktop forces an immediate auto-update check). Omitted when up to date so an up-to-date reply stays lean.
          const update = runnerUpdateRequired(protocol)
            ? { updateRequired: true, serverProtocol: RUNNER_PROTOCOL_VERSION }
            : {};
          return ok({ ...(leased ?? { job: null }), ...update });
        }),
    );
    server.registerTool(
      "submit_job_result",
      {
        description: "Report the leased job's result (CaseResult) → completes the control plane's pending dispatch.",
        inputSchema: { jobId: z.string(), result: CaseResultSchema },
      },
      ({ jobId, result }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: await hub.complete(key, jobId, result) });
        }),
    );
    server.registerTool(
      "fail_job",
      {
        description: "Report the leased job's failure → ends the pending dispatch with an error.",
        inputSchema: { jobId: z.string(), message: z.string() },
      },
      ({ jobId, message }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: await hub.fail(key, jobId, message) });
        }),
    );
    server.registerTool(
      "heartbeat_job",
      {
        description:
          "Runner liveness signal — refresh lastSeenAt. Passing jobId also renews that job's lease to prevent requeue during long runs, and carries back a `cancelled` flag: when true the control plane has stopped this job (a user cancelled / superseded the scorecard) → abort the local run and free the runtime. Passing capabilities scopes which QUEUED jobs this heartbeat keeps alive to the ones this runner could run — so a job whose only capable runner died isn't kept pending forever by incapable survivors.",
        inputSchema: {
          jobId: z.string().optional(),
          capabilities: z.array(z.string()).optional(),
          status: z.string().max(200).optional(),
          statusLevel: z.enum(["info", "warn", "error"]).optional(),
        },
      },
      ({ jobId, capabilities, status, statusLevel }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) {
            await deps.runnerService.touch(key.owner, key.runnerId);
            if (status)
              deps.runnerService.reportStatus(key.runnerId, status, statusLevel ?? "info", new Date().toISOString());
          }
          const hb = jobId ? await hub.heartbeat(key, jobId, capabilities) : undefined;
          return ok({ ok: true, ...(hb ? { extended: hb.extended, cancelled: hb.cancelled } : {}) });
        }),
    );
    // Live screen: for a command harness that declares liveScreen (e.g. browser-use's headless Chromium), the runner
    // captures a frame in the case container and pushes it here so the run detail page can show the live screen. A
    // self-hosted container is unreachable from the control plane, so the frame is PUSHED (not pulled). Keyed by the
    // CP-minted runId; the store serves the latest frame from RunService.screen(). Runner token only, best-effort.
    if (deps.liveFrames) {
      const frames = deps.liveFrames;
      server.registerTool(
        "report_case_screen",
        {
          description:
            "Push the latest live-screen frame (base64 PNG) for a running case, keyed by its runId — the run detail page serves it as the live screen. Only meaningful for a harness that declares liveScreen; best-effort (drop failures).",
          inputSchema: { runId: z.string().min(1), frame: z.string().min(1).max(12_000_000) },
        },
        ({ runId, frame }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            frames.put(runId, frame);
            // Durable replay tee (best-effort) — persist the frame so the run can be replayed after it settles.
            await deps.caseRecorder?.recordFrame(runId, frame);
            return ok({ ok: true });
          }),
      );
    }

    // Live execution log push (observability ②) — the log twin of report_case_screen. A self-hosted runner has no
    // backend the control plane can tail, so it PUSHES its per-case lifecycle lines (started / completed / failed
    // [class/stage]: reason) here, keyed by the CP-minted runId; RunService.logs() serves the accumulated text on the
    // run detail page's live-log panel. Runner token only, best-effort (a push failure must never affect the run).
    if (deps.liveLogs) {
      const logs = deps.liveLogs;
      server.registerTool(
        "report_case_log",
        {
          description:
            "Append a log line for a running case, keyed by its runId — the run detail page streams it as the live execution log. Only meaningful for a self-hosted runner (managed backends read logs from the job directly); best-effort (drop failures).",
          inputSchema: { runId: z.string().min(1), line: z.string().max(16_000) },
        },
        ({ runId, line }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            logs.append(runId, line);
            // Durable replay tee (best-effort) — persist the log line onto the recording's logs lane.
            await deps.caseRecorder?.recordLog(runId, line);
            return ok({ ok: true });
          }),
      );
    }
  }
}
