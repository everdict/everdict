import { z } from "zod";
import { SecretMetaResponseSchema } from "./secret-meta.js";

// Where a workspace secret is referenced — the reverse index that answers "which of my secrets are actually in
// use, and by what". Computed LIVE from the current registry specs + workspace settings at read time, so removing
// a reference (a new harness/model version that drops it, a settings edit) makes the usage disappear on the next
// read — nothing is cached. Values are never involved; a usage names only the referencing resource + the field.

// The kind of resource that holds the reference — drives the web's link target + the (translated) noun.
//  harness/runtime/model = a versioned registry entity (deep-linkable by resourceId) ·
//  mattermost/imageRegistry/traceSource/proxy = a workspace-settings integration.
export const SecretUsageKindSchema = z.enum([
  "harness",
  "runtime",
  "model",
  "mattermost",
  "imageRegistry",
  "traceSource",
  "proxy",
]);
export type SecretUsageKind = z.infer<typeof SecretUsageKindSchema>;

// Which field/use holds the reference (a stable token — the web translates it; never free prose).
//  env = a harness env var {secretRef} · trace-auth = a command harness / trace-source auth · api-key = a model's apiKeySecret ·
//  cluster-token = nomad/k8s authSecret · kubeconfig = k8s kubeconfigSecret · bot-token/command-token = Mattermost ·
//  registry-pull/registry-push = an image registry credential · proxy-auth = a BYO egress proxy's user:pass.
export const SecretUsageFieldSchema = z.enum([
  "env",
  "trace-auth",
  "api-key",
  "cluster-token",
  "kubeconfig",
  "bot-token",
  "command-token",
  "registry-pull",
  "registry-push",
  "proxy-auth",
]);
export type SecretUsageField = z.infer<typeof SecretUsageFieldSchema>;

// One reference site of a secret.
export const SecretUsageRefSchema = z.object({
  kind: SecretUsageKindSchema,
  field: SecretUsageFieldSchema,
  label: z
    .string()
    .describe(
      "The referencing resource's own name — a harness/runtime/model id, a registry/source name, or a GHE host",
    ),
  resourceId: z
    .string()
    .optional()
    .describe("Registry entity id for deep-linking (harness/runtime/model); absent for settings-scoped integrations"),
  version: z.string().optional().describe("The scanned (latest) version of the registry entity"),
  detail: z
    .string()
    .optional()
    .describe("A literal qualifier shown verbatim (an env-var name or a service name) — never translated"),
});
export type SecretUsageRef = z.infer<typeof SecretUsageRefSchema>;

// A workspace secret + its live usage sites. refs=[] means the secret is registered but referenced nowhere (orphan)
// — the web flags it as "unused". Only workspace-scoped secrets are reported (personal secrets are out of scope:
// their user-scoped harness references resolve per-submitter, so attribution would be ambiguous).
export const SecretUsageResponseSchema = SecretMetaResponseSchema.extend({
  refs: z.array(SecretUsageRefSchema),
});
export type SecretUsageResponse = z.infer<typeof SecretUsageResponseSchema>;

export const SecretUsageListResponseSchema = z.array(SecretUsageResponseSchema);
export type SecretUsageListResponse = z.infer<typeof SecretUsageListResponseSchema>;
