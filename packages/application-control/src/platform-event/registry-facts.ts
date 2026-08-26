import type { CapabilityOrigin } from "@everdict/contracts";
import { SHARED_TENANT } from "@everdict/domain";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";

// E2 content/registry facts (event-plumbing.md §3, coverage wave 2): every registry write is a state
// transition — a new immutable version exists — so it emits its fact. The harness/dataset/judge registries
// share one register(tenant, spec, createdBy?) shape, and registration happens from MANY callers (routes, MCP
// tools, bundle apply, benchmark import, the CI re-pin), so the fact is attached as a DECORATOR at the
// composition root — one choke point, exactly like RevisionedWorkspaceFs for file publishes. _shared
// registrations (first-party boot seeds) never emit: seeding is not workspace news.
interface RegisterableSpec {
  id: string;
  version: string;
}

// The decorator must name the registry's FULL parameter list, not just the part it reads. TypeScript accepts a
// wider `register` against a narrower constraint (the extra parameters are optional), so a decorator that
// forwards only what it uses typechecks perfectly and silently drops the rest — which is what happened here:
// every dataset/judge/harness registered through the composed app arrived UNOWNED and unstamped, because
// `teamId` and `origin` stopped at this Proxy. Forward the whole call; read what you need from it.
export function withRegisteredFact<
  S extends RegisterableSpec,
  R extends {
    register(tenant: string, spec: S, createdBy?: string, teamId?: string, origin?: CapabilityOrigin): Promise<void>;
  },
>(
  registry: R,
  kind: "harness.registered" | "dataset.registered" | "judge.registered",
  subjectType: "harness" | "dataset" | "judge",
  events: PlatformEventEmitter,
): R {
  const register = async (
    tenant: string,
    spec: S,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> => {
    await registry.register(tenant, spec, createdBy, teamId, origin); // a refused registration (409/validation) emits nothing
    if (tenant === SHARED_TENANT) return;
    // The payload carries the origin summary so a consumer learns FROM WHAT without a registry read — the
    // fact must hold every value its rendering/filtering needs (rule `events`). A re-pin is a registration
    // whose `from` names its own family; it is this payload, not a second event kind.
    const from = origin?.from;
    const fromLabel = from !== undefined ? `${from.id}${from.version !== undefined ? `@${from.version}` : ""}` : "";
    void events.emit({
      workspace: tenant,
      kind,
      subject: { type: subjectType, id: spec.id },
      ...(createdBy !== undefined ? { actor: createdBy } : {}),
      payload: {
        id: spec.id,
        version: spec.version,
        ...(origin !== undefined ? { origin: { via: origin.via, ...(from !== undefined ? { from } : {}) } } : {}),
      },
      message: `${subjectType} ${spec.id}@${spec.version} registered${from !== undefined ? ` — from ${from.type} ${fromLabel}` : ""}`,
    });
  };
  // A Proxy rather than object spread: registry impls are classes, and a spread would drop every prototype
  // method. Bound functions keep `this` on the real instance.
  return new Proxy(registry, {
    get(target, prop) {
      if (prop === "register") return register;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
