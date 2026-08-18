import { z } from "zod";

// ── THE WORLD A WORKLOAD DECLARES IT NEEDS ───────────────────────────────────────────────────────────
//
// One vocabulary for "how big a box" and "how much network", shared by everything that asks for compute:
// a topology service, a command harness's job, and — since this module — an individual eval case. It lives
// in a leaf module precisely so there is ONE spelling: the same fields were about to be re-declared on the
// case with `memMb` next to the harness's `memoryMb`, and two spellings of one concept diverge (rule
// `protocol` L3 — a predicate written twice has already diverged).

// cpu is MILLICORES (1000 = 1 vCPU, the k8s convention), memoryMb is MiB, gpu is a device count.
// Interpretation per runtime: nomad Resources.CPU(MHz)/MemoryMB · k8s requests/limits (`${cpu}m` / `${memoryMb}Mi`
// / nvidia.com/gpu) · docker `--cpus`(=cpu/1000) / `--memory` / `--gpus`. Unset = the runtime's default.
export const ResourceRequestSchema = z.object({
  cpu: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  // A PORTABLE ask (like cpu/memoryMb), not a node selector: it routes the workload to a gpu-capable runtime
  // and reserves the device; WHICH node pool it lands on stays the runtime's binding.
  gpu: z.number().int().positive().optional(),
});
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;

// ── NETWORK REACH, AS A DECLARATION THAT CAN BE REFUSED ──────────────────────────────────────────────
//
// For an evaluation this is not an ops knob, it is part of what the benchmark MEASURES: an offline
// reasoning task that quietly ran with internet access measured retrieval, and its score is not comparable
// with the one the benchmark's authors published. So the declaration travels with the case and the
// execution site must either enforce it or REFUSE the work — never run it in a different world and report
// a number. (Same discipline as `ComputeSpec.os`: a driver that cannot provide the declared world refuses
// before execution rather than substituting one.)
//
// `allowlist` is deliberately part of the vocabulary even though no driver enforces it yet. Leaving it out
// would force a benchmark that needs `pypi.org` and nothing else to declare `public` — which is a false
// statement about the world the result came from. Declared-and-refused is a usable answer; declared-as-
// something-else is not.
export const NetworkModeSchema = z.enum(["public", "none", "allowlist"]);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;

export const NetworkPolicySchema = z
  .object({
    mode: NetworkModeSchema,
    // Hostnames / IP literals / CIDR ranges reachable in `allowlist` mode. An EMPTY list under `allowlist`
    // denies everything (Harbor's semantics) — it is a valid, meaningful policy, not a missing one.
    allowedHosts: z.array(z.string().min(1)).default([]),
  })
  .refine((policy) => policy.mode === "allowlist" || policy.allowedHosts.length === 0, {
    message: "allowedHosts is only meaningful with mode 'allowlist'",
    path: ["allowedHosts"],
  });
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

// Does this policy ask for anything an execution site has to actively do? `public` with no hosts is what
// every workload got before this existed, so it is the one shape a driver may satisfy by doing nothing —
// and the one shape whose ABSENCE and PRESENCE mean the same thing.
export function isDefaultNetwork(policy: NetworkPolicy | undefined): boolean {
  return policy === undefined || policy.mode === "public";
}

// Does this request ask for anything at all? An object with every field unset is a declaration that says
// nothing, and must not make an execution site refuse work it could have run.
export function isEmptyResourceRequest(request: ResourceRequest | undefined): boolean {
  return (
    request === undefined || (request.cpu === undefined && request.memoryMb === undefined && request.gpu === undefined)
  );
}
