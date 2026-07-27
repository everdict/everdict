import { z } from "zod";

// POST /capabilities/probe-mcp body — test-connect to a candidate mcp capability URL and discover its tools. `token`
// is a transient bearer the author pastes for the test only (never stored; the adopter binds the real secret at
// adoption), so it is optional and off-spec.
export const ProbeCapabilityMcpBodySchema = z.object({
  url: z.string().min(1),
  token: z.string().optional(),
});
