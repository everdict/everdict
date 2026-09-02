import type { HarnessShapeReader } from "@everdict/application-control";
import { AppError, readOk, readUnknown } from "@everdict/contracts";
import type { HarnessSlot } from "@everdict/domain";
import type { HarnessInstanceRegistry } from "@everdict/registry";

// ── THE CANDIDATE'S SHAPE (docs/architecture/evolution-routing-spec.md §2) ────────────────────────────
//
// The resolved spec's slots: a topology's services (name, and the tools each declares it owns), or the single
// `image` slot of a command / process harness. Every read a decision rests on answers `ReadResult`.
export function buildHarnessShape(deps: { harnesses: Pick<HarnessInstanceRegistry, "get"> }): HarnessShapeReader {
  return {
    async slotsOf(tenant, harness) {
      try {
        const spec = await deps.harnesses.get(tenant, harness.id, harness.version);
        const slots: HarnessSlot[] =
          spec.kind === "service"
            ? spec.services.map((svc) => ({ slot: svc.name, service: svc.name, tools: svc.owns?.tools ?? [] }))
            : [{ slot: "image", tools: [] }];
        return readOk(slots);
      } catch (err) {
        if (err instanceof AppError && err.status === 404) return { kind: "absent" };
        return readUnknown(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
