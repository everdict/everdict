import { createHash } from "node:crypto";
import { BadRequestError, type ServiceHarnessSpec } from "@everdict/core";

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
  const names = new Set(spec.services.map((s) => s.name));
  for (const name of Object.keys(pins)) {
    if (!names.has(name)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { service: name, known: [...names] },
        `Image-pin target service '${name}' is not in the topology.`,
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
