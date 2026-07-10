import type { SelfHostedKey } from "@everdict/application-control";
import { CaseResultSchema } from "@everdict/core";
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
          "Fetch the next eval job (runner pull, long-poll). If none, wait up to wait_ms then {job:null} — safe to call again immediately. Passing capabilities self-advertises the runner (e.g. docker detection → service-harness gate). Report the result via submit_job_result.",
        inputSchema: {
          wait_ms: z.number().int().min(0).max(60_000).optional(),
          capabilities: z.array(z.string()).optional(),
        },
      },
      ({ wait_ms, capabilities }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) {
            await deps.runnerService.touch(key.owner, key.runnerId); // mark as connected
            // Update when the runner reports its actual capabilities (docker detection → sharpens the service-harness dispatch gate).
            if (capabilities) await deps.runnerService.setCapabilities(key.owner, key.runnerId, capabilities);
          }
          // Pass capabilities to the hub → placement gate (if a case.image needs docker but the runner lacks it, reject that job outright).
          const leased = await hub.leaseWait(key, wait_ms ?? 0, capabilities); // unset = return immediately (backward compatible)
          return ok(leased ?? { job: null });
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
          return ok({ jobId, accepted: hub.complete(key, jobId, result) });
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
          return ok({ jobId, accepted: hub.fail(key, jobId, message) });
        }),
    );
    server.registerTool(
      "heartbeat_job",
      {
        description:
          "Runner liveness signal — refresh lastSeenAt. Passing jobId also renews that job's lease to prevent requeue during long runs.",
        inputSchema: { jobId: z.string().optional() },
      },
      ({ jobId }) =>
        plain(async () => {
          const key = runnerKey();
          if (!key) return fail(NEED_RUNNER);
          if (deps.runnerService) await deps.runnerService.touch(key.owner, key.runnerId);
          const extended = jobId ? hub.heartbeat(key, jobId) : false;
          return ok({ ok: true, ...(jobId ? { extended } : {}) });
        }),
    );
  }
}
