import { z } from "zod";

// One paired runner's metadata (@everdict/db RunnerMeta). Never carries a token in any form —
// the pairing token is stored as a hash and its plaintext exists only in the pair response.
export const RunnerMetaSchema = z.object({
  id: z.string(),
  label: z.string().describe('Display device name (e.g. "ho-macbook")'),
  os: z.string().optional().describe("linux | darwin | win32 …"),
  capabilities: z
    .array(z.string())
    .describe("What this machine can run (repo | browser | os-use | docker …) — re-probed when the runner attaches"),
  pairedAt: z.string(),
  lastSeenAt: z.string().optional().describe("Last lease/heartbeat time"),
  version: z.string().optional().describe("Runner build/app version (display only) — self-reported on lease"),
  protocol: z.number().int().optional().describe("Runner protocol version — self-reported on lease"),
  updateRequired: z
    .boolean()
    .optional()
    .describe("Derived on read: the runner's protocol is behind the control plane → it should update"),
  status: z
    .object({
      text: z.string(),
      level: z.enum(["info", "warn", "error"]),
      at: z.string(),
    })
    .optional()
    .describe("Overlaid on read (never stored): the runner's self-reported live status/last-error (diagnosability)"),
});
export type RunnerMeta = z.infer<typeof RunnerMetaSchema>;
