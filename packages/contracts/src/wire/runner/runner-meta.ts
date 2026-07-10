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
});
export type RunnerMeta = z.infer<typeof RunnerMetaSchema>;
