import {
  BadRequestError,
  STORE_INJECT_FIELDS,
  type ServiceHarnessSpec,
  injectTemplateFields,
} from "@everdict/contracts";
import type { StoreValues } from "./dependencies.js";

// Dependency env injection (dependencies[].inject) — render a deployed store's coordinates into BYO env names, the
// store-side sibling of service.wiring. ONE pure renderer shared by the docker/nomad/k8s builders so the mapping
// behaves identically on every runtime (the whole point: an unmodified image reading VALKEY_URL /
// OBJECT_STORAGE_ENDPOINT works wherever the harness runs). Rendered values derive from the store the runtime actually
// deployed (endpoint + pool-minted creds), so injected keys are merged ABOVE service.env AND the operational storeEnv —
// they ARE the operational truth, and a stale literal shadowing them is exactly the rupture this exists to close.

// Render one {field} template against a store's coordinates. The vocabulary is closed (STORE_INJECT_FIELDS — the
// schema already rejects unknown fields at registration; this re-check covers registry-bypassing dispatch paths).
// A field the isolation model didn't mint (e.g. {userinfo} on an unauthenticated silo redis) renders as "" by
// contract, so one template covers authenticated and open stores.
export function renderInjectTemplate(store: string, template: string, values: StoreValues): string {
  const allowed = (STORE_INJECT_FIELDS as Record<string, readonly string[] | undefined>)[store];
  for (const field of injectTemplateFields(template)) {
    if (!allowed?.includes(field)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { store, field, template },
        `Unknown inject template field {${field}} for store "${store}" — allowed: ${(allowed ?? []).join(", ")}.`,
      );
    }
  }
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, field: string) => {
    const value = (values as unknown as Record<string, string | undefined>)[field];
    return value ?? "";
  });
}

// The inject env for ONE service: every non-external dependency with inject mappings, scoped by dep.service
// (unset = injected into all services). A store the current runtime configuration did not deploy has no coordinates
// (no entry in storeValues) — skipped, matching how its conventional connEnv is also absent there (the connection then
// comes from the operational storeEnv, as before this feature).
export function dependencyInjectEnv(
  spec: ServiceHarnessSpec,
  storeValues: Partial<Record<string, StoreValues>>,
  serviceName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dep of spec.dependencies ?? []) {
    if (dep.isolateBy === "external" || !dep.inject?.length) continue;
    if (dep.service !== undefined && dep.service !== serviceName) continue;
    const values = storeValues[dep.store];
    if (!values) continue;
    for (const mapping of dep.inject) {
      out[mapping.env] = renderInjectTemplate(dep.store, mapping.template ?? "{url}", values);
    }
  }
  return out;
}
