import { z } from "zod";
import { TraceSourceSpecSchema } from "../harness/harness-spec.js";
import { VersionSchema } from "../version.js";
import { CapabilityNameSchema } from "./capability.js";

// Runtime — an execution-infra definition a tenant registers ("where the eval runs"). local | nomad | k8s.
// (The docker/topology kinds were removed in slice 5b — docker→self-hosted runner, topology→a nomad/k8s traceSource config [= topology capability].)
// A registrable first-class entity (ownership/version/lifecycle follow the same pattern as harness/dataset/judge, immutable-version SSOT).
// ⚠️ No secrets — credentials like a Nomad token/kubeconfig are injected from the tenant SecretStore (at dispatch). Only non-secret connection info here.
// Same fields as @everdict/backends BackendConfig (id/version instead of name) — buildRuntimeBackend turns this into a live Backend.

const base = {
  id: z.string(),
  version: VersionSchema,
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  // Capabilities this runtime provides (declared or probe-detected) — matched against the harness's requirements
  // (requiredCapabilities) via functionalGate. The self-hosted runner advertises via self-probe; a registered runtime
  // (nomad/k8s) declares them here or fills them via probe. Absent = unchecked (backward-compatible). Design: docs/architecture/self-hosted-runtime-and-runners.md.
  capabilities: z.array(CapabilityNameSchema).optional(),
  // Admission envelope — how much the control plane may pack onto this runtime CONCURRENTLY. The cluster's own
  // scheduler still does node-level bin-packing; these declared bounds keep the control plane from over-committing
  // it in the first place. maxConcurrent = slot cap (absent → the backend's default). memoryBudgetMb = the sum of
  // in-flight harness-declared memory (resources.memoryMb) the Scheduler may admit at once; harnesses that declare
  // no memory are admitted outside this budget (resource-aware admission is opt-in by declaring).
  maxConcurrent: z.number().int().positive().optional(),
  memoryBudgetMb: z.number().int().positive().optional(),
  // cpuBudget = the CPU twin: sum of in-flight harness-declared cpu (resources.cpu, 1000 = 1 vCPU / Nomad MHz)
  // the Scheduler may admit at once; undeclared harnesses are admitted outside it (same opt-in as memory).
  cpuBudget: z.number().int().positive().optional(),
};

// local — in-process execution on the control-plane host (dev only). This is the control plane's host, not "the user's machine" —
// running a workspace harness/dataset on your own machine is superseded by the self-hosted runner (personally owned) (docs/architecture/self-hosted-runner.md).
export const LocalRuntimeSpecSchema = z.object({ kind: z.literal("local"), ...base });

// The docker (single-host daemon) runtime kind was removed (slice 5b) — a "single docker host" is superseded by the
// self-hosted runner executing (pulling) via local docker. Container-execution capability is now the `docker` capability, not a runtime kind.

// topology support config — when a nomad/k8s runtime has a traceSource, it hosts multi-service topology harnesses (kind:"service",
// e.g. browser-use) (→ apps/api routes it via ServiceTopologyBackend; as a capability it is `topology`).
// Without a traceSource it is a plain compute runtime. (The old topology kind was removed in slice 5b-2 — the orchestrator is implied by kind [nomad|k8s].)
const topologyConfig = {
  // 5 kinds + auth/correlate/scope (G1) — a runtime can point its topology harnesses at Langfuse/LangSmith/Phoenix, not
  // just OTel/MLflow. authSecret resolves from the tenant SecretStore at dispatch; per-harness selection can still
  // override this fixed source via the workspace trace-source registry.
  traceSource: TraceSourceSpecSchema.optional(),
  browserImage: z.string().optional(), // per-case browser image (falls back to the runtime default)
};

export const NomadRuntimeSpecSchema = z.object({
  kind: z.literal("nomad"),
  ...base,
  addr: z.string().url(), // Nomad HTTP endpoint (e.g. http://nomad.internal:4646)
  image: z.string(), // job-runner image (tenant registry)
  runtime: z.string().optional(), // docker isolation runtime (e.g. runsc=gVisor)
  datacenters: z.array(z.string()).optional(),
  namespace: z.string().optional(),
  // SecretStore key name of the token for control-plane↔Nomad API auth (ACL) — used as the X-Nomad-Token header.
  // The name only, not the value (token). This token is not injected into the alloc env (never expose the cluster token to the agent).
  authSecret: z.string().optional(),
  ...topologyConfig, // with a traceSource, this Nomad runtime hosts topology (service harnesses)
});

export const K8sRuntimeSpecSchema = z.object({
  kind: z.literal("k8s"),
  ...base,
  image: z.string(),
  context: z.string().optional(), // kubeconfig context (relative to the control-plane host) — local kubeconfig auth
  namespace: z.string().optional(),
  runtimeClass: z.string().optional(), // runtimeClassName (gVisor=gvisor etc.)
  server: z.string().url().optional(), // external API server URL (when authenticating with a bearer token instead of context)
  // SecretStore key name of the K8s API bearer token (with server — kubectl --token). The name, not the value; never leaks into the alloc env.
  authSecret: z.string().optional(),
  // SecretStore key name holding the full kubeconfig (YAML), not the value. For clusters (EKS/GKE etc.) where a token alone
  // won't do, like exec-plugin/client-cert auth. Materialized to a temp file (0600) at dispatch → kubectl --kubeconfig, then removed.
  // Auth precedence: kubeconfigSecret > (server + authSecret) > context. This value also never leaks into the alloc env.
  kubeconfigSecret: z.string().optional(),
  ...topologyConfig, // with a traceSource, this K8s runtime hosts topology (service harnesses)
});

export const RuntimeSpecSchema = z.discriminatedUnion("kind", [
  LocalRuntimeSpecSchema,
  NomadRuntimeSpecSchema,
  K8sRuntimeSpecSchema,
]);
export type RuntimeSpec = z.infer<typeof RuntimeSpecSchema>;
