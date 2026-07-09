import { z } from "zod";

// GET /harnesses/:id 200 — the id's live versions + version tags (display aid for the version switcher).
export const HarnessVersionsResponseSchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Live versions (semver ascending)"),
  versionTags: z
    .record(z.array(z.string()))
    .optional()
    .describe("version → free-form labels (present only when at least one version is tagged)"),
});
