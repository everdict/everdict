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

export function withRegisteredFact<
  S extends RegisterableSpec,
  R extends { register(tenant: string, spec: S, createdBy?: string): Promise<void> },
>(
  registry: R,
  kind: "harness.registered" | "dataset.registered" | "judge.registered",
  subjectType: "harness" | "dataset" | "judge",
  events: PlatformEventEmitter,
): R {
  const register = async (tenant: string, spec: S, createdBy?: string): Promise<void> => {
    await registry.register(tenant, spec, createdBy); // a refused registration (409/validation) emits nothing
    if (tenant === SHARED_TENANT) return;
    void events.emit({
      workspace: tenant,
      kind,
      subject: { type: subjectType, id: spec.id },
      ...(createdBy !== undefined ? { actor: createdBy } : {}),
      payload: { id: spec.id, version: spec.version },
      message: `${subjectType} ${spec.id}@${spec.version} registered`,
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
