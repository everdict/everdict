import { z } from "zod";

// GET /runs/:id/screen — the run's current screen frame as a PNG data URL (os-use desktop / browser targets).
export const RunScreenResponseSchema = z.object({
  supported: z.boolean().describe("false for env kinds without a single-container screen (not os-use/browser)"),
  found: z.boolean().describe("false = no frame captured (no live container or capture failed)"),
  dataUrl: z.string().describe("PNG data URL (empty string when found=false)"),
});
