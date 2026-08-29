import { type SelfHostedKey, runnerUpdateRequired } from "@everdict/application-control";
import {
  RUNNER_PROTOCOL_VERSION,
  TrackEntrySchema,
  UntrustedCaseResultSchema,
  UntrustedTraceEventSchema,
} from "@everdict/contracts";
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

    // ── EVERY REPORT IS AUTHORIZED BY THE LEASE, AND THE RUN IS READ FROM IT ─────────────────────────
    //
    // Every report below used to take the caller's `runId` on trust: a valid runner credential plus any run id
    // the runner happened to know was enough to push frames, logs and DURABLE track entries onto that run —
    // including a run it no longer held, since an expired lease is requeued under the same job id and nothing
    // told the previous holder it had been replaced. The receiving process then stamped whatever attempt IT
    // knew about, so a stale producer's report was not merely accepted: it was RE-LABELLED as the successor's.
    //
    // The attempt token fixes the identity at its source. `runId` comes from the leased job, never from the
    // request — the caller's own claim is never written to, not even for the "ephemeral" live view: the live
    // screen/log/trace is what an operator judges a running case by, so a stale or foreign producer writing
    // it is lying to a person even when no verdict reads it. Protocol v2 makes the token universal (a v1
    // runner is refused a lease), so a report without one is not "an old runner" — it is not a current lease.
    //
    // `live` (token valid, but the job opened no recording attempt) keeps the live view and refuses only the
    // durable half — identity is proven; there is simply no attempt row to persist into.
    const attemptFields = { jobId: z.string().min(1).optional(), leaseEpoch: z.number().int().min(1).optional() };
    type Reported = { jobId?: string; leaseEpoch?: number };
    type ReportAuthority =
      | { kind: "refused"; reason: string }
      | { kind: "live"; runId: string; reason: string }
      | { kind: "durable"; runId: string; generation: number };
    const authorize = async (key: SelfHostedKey, input: Reported): Promise<ReportAuthority> => {
      if (input.jobId === undefined || input.leaseEpoch === undefined)
        return { kind: "refused", reason: "no attempt token (update the runner)" };
      const authority = await hub.authorizeAttempt(key, { jobId: input.jobId, leaseEpoch: input.leaseEpoch });
      if (!authority) return { kind: "refused", reason: "the attempt token is not a current lease" };
      // The lease decides which run this is about. A job with no runId (a dispatch that minted none) has no
      // destination for a report — there is nothing for the evidence to belong to.
      if (!authority.runId) return { kind: "refused", reason: "this job carries no run id" };
      // …and which ATTEMPT's recording it may write into. The number rode in on the job this runner leased;
      // a job dispatched without one opened no attempt, so there is nothing durable to write — but the lease
      // is real, so the live view stays.
      if (authority.recordingGeneration === undefined)
        return { kind: "live", runId: authority.runId, reason: "this job opened no recording attempt" };
      return { kind: "durable", runId: authority.runId, generation: authority.recordingGeneration };
    };

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
          // A runner older than this control plane is REFUSED a lease (not merely advised): since protocol v2 the
          // result wire requires the attempt token, and a build that cannot carry one must not be able to take an
          // attempt it cannot prove it holds. The reply still says why (updateRequired → the desktop forces an
          // immediate auto-update check), so the refusal is diagnosable, not a silent empty queue.
          if (runnerUpdateRequired(protocol))
            return ok({ job: null, updateRequired: true, serverProtocol: RUNNER_PROTOCOL_VERSION });
          // Pass capabilities to the hub → placement gate (if a case.image needs docker but the runner lacks it, reject that job outright).
          const leased = await hub.leaseWait(key, wait_ms ?? 0, capabilities); // unset = return immediately (backward compatible)
          return ok(leased ?? { job: null });
        }),
    );
    // ── THE RESULT WIRE CARRIES THE SAME TOKEN AS THE EVIDENCE WIRE (protocol v2) ────────────────────
    // A result, a failure and a lease renewal each ACT ON an attempt, so each must prove which attempt it is —
    // the epoch is required, and the hub/store refuse a token that is not the current lease. Without this, a
    // paused runner's late submit became the canonical completion of its successor's execution, its fail_job
    // ended a healthy attempt, and its heartbeat kept a dead attempt looking alive.
    server.registerTool(
      "submit_job_result",
      {
        description:
          "Report the leased job's result (CaseResult) → completes the control plane's pending dispatch. Requires the lease's attempt token (leaseEpoch); a token that is not the current lease is refused (accepted:false).",
        inputSchema: { jobId: z.string(), leaseEpoch: z.number().int().min(1), result: UntrustedCaseResultSchema },
      },
      ({ jobId, leaseEpoch, result }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: await hub.complete(key, { jobId, leaseEpoch }, result) });
        }),
    );
    server.registerTool(
      "fail_job",
      {
        description:
          "Report the leased job's failure → ends the pending dispatch with an error. Requires the lease's attempt token (leaseEpoch); a token that is not the current lease is refused (accepted:false).",
        inputSchema: { jobId: z.string(), leaseEpoch: z.number().int().min(1), message: z.string() },
      },
      ({ jobId, leaseEpoch, message }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          return ok({ jobId, accepted: await hub.fail(key, { jobId, leaseEpoch }, message) });
        }),
    );
    server.registerTool(
      "heartbeat_job",
      {
        description:
          "Runner liveness signal — refresh lastSeenAt. Passing jobId (with the lease's leaseEpoch) also renews that job's lease to prevent requeue during long runs, and carries back a `cancelled` flag: when true the control plane has stopped this job (a user cancelled / superseded the scorecard) → abort the local run and free the runtime. Passing capabilities scopes which QUEUED jobs this heartbeat keeps alive to the ones this runner could run — so a job whose only capable runner died isn't kept pending forever by incapable survivors.",
        inputSchema: {
          jobId: z.string().optional(),
          leaseEpoch: z.number().int().min(1).optional(),
          capabilities: z.array(z.string()).optional(),
          status: z.string().max(200).optional(),
          statusLevel: z.enum(["info", "warn", "error"]).optional(),
        },
      },
      ({ jobId, leaseEpoch, capabilities, status, statusLevel }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) {
            await deps.runnerService.touch(key.owner, key.runnerId);
            if (status)
              deps.runnerService.reportStatus(key.runnerId, status, statusLevel ?? "info", new Date().toISOString());
          }
          // A job heartbeat without the epoch extends nothing — "which lease" is exactly what a renewal asserts.
          if (jobId !== undefined && leaseEpoch === undefined)
            return ok({ ok: true, extended: false, cancelled: false, reason: "no attempt token (update the runner)" });
          const hb =
            jobId !== undefined && leaseEpoch !== undefined
              ? await hub.heartbeat(key, { jobId, leaseEpoch }, capabilities)
              : undefined;
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
            "Push the latest live-screen frame (base64 PNG) for the case this attempt token holds — the run detail page serves it as the live screen (the run is read from the lease, never from the request). Only meaningful for a harness that declares liveScreen; best-effort (drop failures).",
          inputSchema: { frame: z.string().min(1).max(12_000_000), ...attemptFields },
        },
        ({ frame, jobId, leaseEpoch }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            const auth = await authorize(key, { ...(jobId ? { jobId } : {}), ...(leaseEpoch ? { leaseEpoch } : {}) });
            // An unproven producer writes NOTHING — not even the live view (it is what an operator judges a
            // running case by, and the caller-claimed runId is exactly how a stale producer overwrote it).
            if (auth.kind === "refused") return ok({ ok: false, durable: false, reason: auth.reason });
            frames.put(auth.runId, frame); // the live view may run ahead of the durable fence (a proven lease with no attempt row)
            // Durable replay tee (best-effort) — persist the frame so the run can be replayed after it settles.
            if (auth.kind === "durable") await deps.caseRecorder?.recordFrame(auth.runId, frame, auth.generation);
            return ok({
              ok: true,
              durable: auth.kind === "durable",
              ...(auth.kind === "live" ? { reason: auth.reason } : {}),
            });
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
            "Append a log line for the case this attempt token holds — the run detail page streams it as the live execution log (the run is read from the lease, never from the request). Only meaningful for a self-hosted runner (managed backends read logs from the job directly); best-effort (drop failures).",
          inputSchema: { line: z.string().max(16_000), ...attemptFields },
        },
        ({ line, jobId, leaseEpoch }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            const auth = await authorize(key, { ...(jobId ? { jobId } : {}), ...(leaseEpoch ? { leaseEpoch } : {}) });
            if (auth.kind === "refused") return ok({ ok: false, durable: false, reason: auth.reason });
            logs.append(auth.runId, line);
            // Durable replay tee (best-effort) — persist the log line onto the recording's logs lane.
            if (auth.kind === "durable") await deps.caseRecorder?.recordLog(auth.runId, line, auth.generation);
            return ok({
              ok: true,
              durable: auth.kind === "durable",
              ...(auth.kind === "live" ? { reason: auth.reason } : {}),
            });
          }),
      );
    }

    // Live trace push (observability ⑨) — the trajectory twin of report_case_log. The runner tees the TraceEvents
    // runCase drains from the harness into short-cadence batches and pushes them here, keyed by the CP-minted
    // runId; RunService.liveTrace() serves the accumulated events on the run detail page's live-trace panel. The
    // sealed result stays the durable record. Runner token only, best-effort (a push failure never affects the run).
    if (deps.liveTraces) {
      const traces = deps.liveTraces;
      server.registerTool(
        "report_case_trace",
        {
          description:
            "Push a batch of drained TraceEvents for the case this attempt token holds — the run detail page shows the trajectory accumulating live (the run is read from the lease, never from the request). Only meaningful for a self-hosted runner (managed jobs print event-sentinel stdout lines instead); best-effort (drop failures).",
          inputSchema: {
            events: z.array(UntrustedTraceEventSchema).min(1).max(500),
            ...attemptFields,
          },
        },
        ({ events, jobId, leaseEpoch }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            const auth = await authorize(key, { ...(jobId ? { jobId } : {}), ...(leaseEpoch ? { leaseEpoch } : {}) });
            // The refusal is stated, not swallowed — this tool used to reply ok:true while its authorize
            // result was never read, so an unauthorized producer was not even told it was one.
            if (auth.kind === "refused") return ok({ ok: false, reason: auth.reason });
            traces.append(auth.runId, events); // live only — the sealed result stays the durable record
            return ok({ ok: true });
          }),
      );
    }

    // Generic deep-track push — the deep-capture twin of report_case_screen/report_case_log. A producer (a browser
    // CDP recorder, a runtime sampler, …) pushes a prepared TrackEntry (network/console/nav/dom/runtime/custom;
    // byte-heavy entries carry an already-offloaded ref) here, keyed by the CP-minted runId; the durable recorder
    // appends it so it replays on the run detail. Runner token only, best-effort.
    if (deps.caseRecorder) {
      const recorder = deps.caseRecorder;
      server.registerTool(
        "report_case_track",
        {
          description:
            "Push one prepared replay track entry (network/console/nav/dom/runtime/custom — byte-heavy entries carry an offloaded ref) for the case this attempt token holds (the run is read from the lease, never from the request). The deep-capture twin of report_case_screen/report_case_log; best-effort.",
          inputSchema: { item: TrackEntrySchema, ...attemptFields },
        },
        ({ item, jobId, leaseEpoch }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            const auth = await authorize(key, { ...(jobId ? { jobId } : {}), ...(leaseEpoch ? { leaseEpoch } : {}) });
            // This tool has no ephemeral half at all — a track entry IS durable evidence, so an unauthorized
            // one is not written anywhere and the refusal is stated rather than swallowed.
            if (auth.kind !== "durable") return ok({ ok: false, durable: false, reason: auth.reason });
            await recorder.recordTrack(auth.runId, item, auth.generation);
            return ok({ ok: true, durable: true });
          }),
      );
    }

    // Run-workbench fs rendezvous (self-hosted parity): the control plane cannot exec into a runner's sandbox,
    // so fs reads PARK on the hub and the runner's in-case servicing loop drains + answers them here. The
    // ATTEMPT TOKEN decides which run's requests this producer may drain/answer — the parked side is a
    // workbench read a member is waiting on, and a caller-supplied runId let ANY paired runner (any owner)
    // silently steal another workspace's parked reads and inject arbitrary tree/file content as the answer.
    // Both halves are best-effort (an unanswered request times out on the parked side).
    if (deps.caseFsRequests) {
      const fsHub = deps.caseFsRequests;
      // The one lease→run resolution both halves share: only the CURRENT holder of the lease that carries a
      // runId may touch that run's parked requests.
      const fsRun = async (key: SelfHostedKey, jobId: string, leaseEpoch: number): Promise<string | undefined> => {
        const auth = await authorize(key, { jobId, leaseEpoch });
        return auth.kind === "refused" ? undefined : auth.runId;
      };
      server.registerTool(
        "poll_case_fs_requests",
        {
          description:
            "Drain the control plane's parked run-workbench repo reads (fs tree / file) for the case this attempt token holds (the run is read from the lease, never from the request). The runner's in-case loop answers each via answer_case_fs_request.",
          inputSchema: { jobId: z.string().min(1), leaseEpoch: z.number().int().min(1) },
        },
        ({ jobId, leaseEpoch }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            const runId = await fsRun(key, jobId, leaseEpoch);
            if (runId === undefined) return ok({ requests: [], reason: "the attempt token is not a current lease" });
            return ok({ requests: fsHub.pending(runId) });
          }),
      );
      server.registerTool(
        "answer_case_fs_request",
        {
          description:
            "Answer one parked run-workbench repo read with the tree/file served from inside the case this attempt token holds. An absent payload is a real answer (not a repo / no such file).",
          inputSchema: {
            jobId: z.string().min(1),
            leaseEpoch: z.number().int().min(1),
            requestId: z.string().min(1),
            result: CaseFsAnswerSchema,
          },
        },
        ({ jobId, leaseEpoch, requestId, result }) =>
          plain(async () => {
            const key = runnerKey();
            if (!key) return fail(NEED_RUNNER);
            const runId = await fsRun(key, jobId, leaseEpoch);
            if (runId === undefined) return ok({ ok: false, reason: "the attempt token is not a current lease" });
            fsHub.answer(runId, requestId, result);
            return ok({ ok: true });
          }),
      );
    }
  }
}

// The runner's answer payloads, validated at this boundary (the runner is remote — never trust the wire).
// Shapes mirror the contracts' CaseFsTreePayload/CaseFsFilePayload (plain interfaces on RunContext).
const CaseFsTreePayloadSchema = z.object({
  files: z.array(z.object({ path: z.string(), status: z.enum(["modified", "added", "deleted"]).optional() })),
  truncated: z.boolean(),
});
const CaseFsFilePayloadSchema = z.object({
  path: z.string(),
  size: z.number(),
  binary: z.boolean(),
  truncated: z.boolean(),
  content: z.string(),
  diff: z.string(),
});
const CaseFsAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fsTree"), tree: CaseFsTreePayloadSchema.optional() }),
  z.object({ kind: z.literal("fsFile"), file: CaseFsFilePayloadSchema.optional() }),
]);
