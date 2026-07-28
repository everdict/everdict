import { createHash } from "node:crypto";
import { BadRequestError, type ServiceHarnessSpec, serviceIsHostExec } from "@everdict/contracts";

// Pin map → deterministic string (sorted keys) — same pins yield the same hash, different pins a different hash.
function stableStringify(pins: Record<string, string>): string {
  return JSON.stringify(Object.entries(pins).sort((a, b) => a[0].localeCompare(b[0])));
}

// Apply per-dispatch image pins (#5) — service name → image override. When pins are present, append a
// deterministic suffix (-pin-<hash>) to the effective version so the pinned variant becomes a distinct topology
// identity and warm pools don't mix (topologyJobId is keyed by id@version, so warm pools separate automatically
// without touching the runtime — same as the instance model).
export function applyImagePins(spec: ServiceHarnessSpec, pins?: Record<string, string>): ServiceHarnessSpec {
  if (!pins || Object.keys(pins).length === 0) return spec;
  const byName = new Map(spec.services.map((s) => [s.name, s] as const));
  for (const name of Object.keys(pins)) {
    const svc = byName.get(name);
    if (!svc) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { service: name, known: [...byName.keys()] },
        `Image-pin target service '${name}' is not in the topology.`,
      );
    }
    // A host-exec service runs no container — pinning an image onto it is a config error, not a silent no-op.
    if (serviceIsHostExec(svc)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { service: name },
        `Image-pin target service '${name}' is host-exec — it runs no image.`,
      );
    }
  }
  const services = spec.services.map((s) => {
    const image = pins[s.name];
    return image ? { ...s, image } : s;
  });
  const suffix = createHash("sha1").update(stableStringify(pins)).digest("hex").slice(0, 8);
  return { ...spec, version: `${spec.version}-pin-${suffix}`, services };
}
