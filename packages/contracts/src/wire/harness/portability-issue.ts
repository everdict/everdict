import { z } from "zod";

// A single cross-runtime portability finding — the serialization mirror of @everdict/domain's PortabilityIssue.
// Surfaced by the template validate route so the wizard can anchor each issue to the offending service/field
// (rule/severity drive the display styling; error blocks a portable spec, warning is a migratable host-literal).
export const PortabilityIssueSchema = z.object({
  rule: z.string().describe("Portability rule id (e.g. peer-by-literal, needs-complete, unique-ports)"),
  severity: z.enum(["error", "warning"]).describe("error = resolves differently per runtime; warning = migratable"),
  service: z.string().optional().describe("The offending service, when the issue is service-scoped"),
  field: z.string().describe("Locator, e.g. services[web].env.API_URL or frontDoor.service"),
  message: z.string().describe("What is wrong + how to make it portable"),
});
export type PortabilityIssue = z.infer<typeof PortabilityIssueSchema>;
