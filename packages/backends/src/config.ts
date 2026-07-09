import { z } from "zod";
import { K8sBackend } from "./k8s.js";
import { LocalBackend } from "./local.js";
import { NomadBackend } from "./nomad.js";
import { BackendRegistry } from "./registry.js";

// --- Build the registry from config (declares multiple clusters/pools; Zod-validated as external input) ---
export const BackendConfigSchema = z.discriminatedUnion("kind", [
  z.object({ name: z.string(), kind: z.literal("local") }),
  z.object({
    name: z.string(),
    kind: z.literal("nomad"),
    addr: z.string(),
    image: z.string(),
    runtime: z.string().optional(),
    datacenters: z.array(z.string()).optional(),
  }),
  z.object({
    name: z.string(),
    kind: z.literal("k8s"),
    image: z.string(),
    context: z.string().optional(), // kubeconfig context (e.g. kind-everdict)
    namespace: z.string().optional(),
    runtimeClass: z.string().optional(), // gVisor=gvisor etc.
  }),
]);
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

export const BackendsConfigSchema = z.object({
  default: z.string().optional(),
  backends: z.array(BackendConfigSchema),
});
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;

export function buildRegistry(
  cfg: BackendsConfig,
  opts: { secretEnv?: Record<string, string> } = {},
): { registry: BackendRegistry; defaultTarget: string | undefined } {
  const registry = new BackendRegistry();
  for (const b of cfg.backends) {
    if (b.kind === "local") {
      registry.register(b.name, new LocalBackend());
    } else if (b.kind === "k8s") {
      registry.register(
        b.name,
        new K8sBackend({
          image: b.image,
          context: b.context,
          namespace: b.namespace,
          runtimeClass: b.runtimeClass,
          secretEnv: opts.secretEnv,
        }),
      );
    } else {
      registry.register(
        b.name,
        new NomadBackend({
          addr: b.addr,
          image: b.image,
          runtime: b.runtime,
          datacenters: b.datacenters,
          secretEnv: opts.secretEnv,
        }),
      );
    }
  }
  return { registry, defaultTarget: cfg.default };
}
