import { z } from "zod";

// GET /runs/:id/screen — the run's current screen frame as a PNG data URL (os-use desktop / browser targets /
// self-hosted push). The client stops polling once status is terminal (the live screen only exists while it runs).
export const RunScreenResponseSchema = z.object({
  status: z.string().describe("the run's status — clients stop polling once it is terminal"),
  supported: z
    .boolean()
    .describe(
      "whether a screen could actually be captured for this run — false covers both 'this kind of run has no screen' and 'this execution lane cannot reach it', so a client renders nothing rather than an empty frame",
    ),
  found: z.boolean().describe("false = no frame captured yet (no live container / capture failed / not pushed yet)"),
  dataUrl: z.string().describe("PNG data URL (empty string when found=false)"),
});
export type RunScreenResponse = z.infer<typeof RunScreenResponseSchema>;
