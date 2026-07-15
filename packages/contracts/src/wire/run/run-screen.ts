import { z } from "zod";

// GET /runs/:id/screen — the run's current screen frame as a PNG data URL (os-use desktop / browser targets /
// self-hosted push). The client stops polling once status is terminal (the live screen only exists while it runs).
export const RunScreenResponseSchema = z.object({
  status: z.string().describe("the run's status — clients stop polling once it is terminal"),
  supported: z
    .boolean()
    .describe("false for runs with no live screen (not os-use/browser and no pushed frame from a self-hosted runner)"),
  found: z.boolean().describe("false = no frame captured yet (no live container / capture failed / not pushed yet)"),
  dataUrl: z.string().describe("PNG data URL (empty string when found=false)"),
});
export type RunScreenResponse = z.infer<typeof RunScreenResponseSchema>;
