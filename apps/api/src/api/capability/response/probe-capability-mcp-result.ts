import { z } from "zod";

// POST /capabilities/probe-mcp response — reachability + the discovered tool list (used to prefill `provides`). A
// failure is a RESULT, not an error (reachable:false + reason), mirroring the trace-source / mattermost probes.
export const ProbeCapabilityMcpResultSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(["auth", "unreachable", "protocol"]).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
});
