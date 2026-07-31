import { z } from "zod";

// PUT /agent/tools/:key/secrets — point a tool's DECLARED secret names at real secret names in this workspace.
// Values never appear here (as everywhere: a spec references a secret by NAME, never by value). An omitted entry
// keeps the current binding, so a partial body is a partial edit rather than a silent unbind; a blank one clears
// the remap where a default exists to fall back to (a hand-wired server's auth · the spec-level overlay).
export const BindAgentToolSecretsBodySchema = z
  .object({
    bindings: z.record(z.string()).describe("Declared secret name → the workspace/personal secret name it should read"),
  })
  .strict();
export type BindAgentToolSecretsBody = z.infer<typeof BindAgentToolSecretsBodySchema>;
