import { type TrustZonePolicy, perTenantTrustZones } from "@everdict/domain";

// WHO decides how a tenant's dispatched work is isolated — one answer for the whole process, chosen by the
// operator and ANNOUNCED at boot.
//
// Why this is explicit rather than "secure by default": switching per-tenant zones on rewrites every
// dispatch's runtime (`runsc`) and namespace (`everdict-<tenant>`). On a cluster without gVisor installed, or
// without those namespaces created, that turns a working deployment into one where every job fails — and
// `assertHardenedIsolation` additionally REFUSES an untrusted zone on a non-hardened runtime, by design. So
// the policy is a deployment decision with a prerequisite, not a flag we can flip on someone's behalf.
//
// What is NOT acceptable is the state this replaced: the backends accepted a policy, the domain implemented
// one, and the composition never passed it — so a control plane could believe it enforced tenant isolation
// while running every tenant's code with whatever the RuntimeSpec happened to declare. Silence was the bug;
// the operator now gets a line at boot saying which of the two is true.
export type TrustZoneMode = "runtime-declared" | "per-tenant";

export function buildTrustZones(env: NodeJS.ProcessEnv = process.env): {
  mode: TrustZoneMode;
  trustZones?: TrustZonePolicy;
} {
  const raw = (env.EVERDICT_TRUST_ZONES ?? "").trim();
  if (raw === "" || raw === "runtime-declared") {
    console.log(
      "▶ trust zones: runtime-declared — a dispatch is isolated by what its RuntimeSpec declares " +
        "(set EVERDICT_TRUST_ZONES=per-tenant to enforce a zone per tenant; needs a hardened runtime + namespaces)",
    );
    return { mode: "runtime-declared" };
  }
  if (raw !== "per-tenant") {
    // An unrecognized value is the dangerous case: the operator asked for SOMETHING and would otherwise get
    // the permissive default silently. Fail the boot instead — an isolation setting nobody honors is worse
    // than one that refuses to start.
    throw new Error(
      `EVERDICT_TRUST_ZONES='${raw}' is not a trust-zone mode (expected 'runtime-declared' or 'per-tenant').`,
    );
  }
  const isolationRuntime = env.EVERDICT_TRUST_ZONE_RUNTIME?.trim() || undefined;
  const namespacePrefix = env.EVERDICT_TRUST_ZONE_NAMESPACE_PREFIX?.trim() || undefined;
  const trustZones = perTenantTrustZones({
    ...(isolationRuntime ? { isolationRuntime } : {}),
    ...(namespacePrefix ? { namespacePrefix } : {}),
  });
  console.log(
    `▶ trust zones: per-tenant — every dispatch runs under ${isolationRuntime ?? "runsc"} in ` +
      `${namespacePrefix ?? "everdict-"}<tenant> (a non-hardened runtime is refused)`,
  );
  return { mode: "per-tenant", trustZones };
}
