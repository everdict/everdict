import { BadRequestError, type HarnessSpec, type RuntimeSpec } from "@everdict/contracts";
import { requiredCapabilitiesForHarness, runtimeSatisfies } from "@everdict/domain";

// Submit-time placement preflight — the control-plane twin of the RuntimeDispatcher's per-case gate, applied once at
// submit so a whole run/scorecard is rejected (400) the instant it's submitted rather than each case failing at
// dispatch. Checks the chosen runtime's advertised capabilities against what the harness requires
// (requiredCapabilitiesForHarness: docker + os-windows/os-macos for a topology). Injected into RunService /
// ScorecardService by the composition root; the RuntimeDispatcher stays the per-case backstop.
//
// Skips (returns without throwing) when it can't or shouldn't gate:
//  - self:* targets — a self-hosted runner's capabilities are known only at lease time (the runner hub gates there);
//  - the target isn't a registered runtime — dispatch resolves it (or fails NOT_FOUND) later;
//  - the runtime declared no capabilities — backward-compatible (runtimeSatisfies is a no-op until an operator labels it);
//  - a non-topology harness — it has no submit-time (harness-level) requirement (case-level caps gate at dispatch).
export type PlacementPreflight = (input: {
  tenant: string;
  target: string;
  harness: { id: string; version: string };
}) => Promise<void>;

export function buildPlacementPreflight(deps: {
  resolveHarness: (tenant: string, id: string, version: string) => Promise<HarnessSpec | undefined>;
  resolveRuntime: (tenant: string, id: string) => Promise<RuntimeSpec | undefined>;
}): PlacementPreflight {
  return async ({ tenant, target, harness }) => {
    if (!target || target.startsWith("self")) return; // self / self:ws / self:<id> — gated at lease time, not here
    const runtime = await deps.resolveRuntime(tenant, target).catch(() => undefined);
    if (!runtime) return; // not a registered runtime (a global backend name or unknown → dispatch handles it)
    const spec = await deps.resolveHarness(tenant, harness.id, harness.version).catch(() => undefined);
    if (!spec) return; // unknown harness → let the normal resolution path surface NOT_FOUND
    const required = requiredCapabilitiesForHarness(spec);
    if (required.length === 0) return; // non-topology harness — nothing to gate at submit
    if (runtimeSatisfies(runtime.capabilities, required)) return;
    throw new BadRequestError(
      "BAD_REQUEST",
      { runtime: target, need: required, have: runtime.capabilities ?? [] },
      `Runtime "${target}" can't run harness "${harness.id}" — it lacks required capabilities [${required.join(", ")}]${
        runtime.capabilities
          ? ` (it advertises [${runtime.capabilities.join(", ")}])`
          : " (label the runtime's capabilities, e.g. os-windows, to enable this gate)"
      }. Choose a runtime whose nodes provide them.`,
    );
  };
}
