import {
  BadRequestError,
  ConflictError,
  type EnvironmentSpec,
  type EvalCase,
  InternalError,
  type SealedEnvironmentEntry,
  caseEnvironmentImageDefect,
} from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { EnvironmentRegistry } from "../ports/environment-registry.js";

// ── RESOLVING A CASE'S ENVIRONMENT REFERENCE, AND PINNING IT (harness-definability-spec.md §2) ────────
//
// One function for both moments, because they are one decision asked twice and a second spelling of it
// would diverge (rule `protocol` L3). At SUBMIT there is no seal yet: a ref resolves (a `latest` ref is
// allowed) and the concrete version it landed on becomes the seal. At every EXECUTION lane afterwards the
// seal is handed back, and the ref resolves at the SEALED version — the seal IS the pin, never a fresh
// latest-resolution that could hand a resumed batch a different world than the one it started in.
//
// A referencing case with no registry configured is REFUSED by name. The registry is optional at the
// composition root (a deployment may run without one), and an optional capability that silently degrades is
// the shape rule `protocol` names: the case asked to run against a registered world, and running it against
// something else would answer a question nobody asked.
export interface ResolvedCaseEnvironments {
  cases: EvalCase[];
  seals: Record<string, SealedEnvironmentEntry>;
}

export async function resolveCaseEnvironments(input: {
  tenant: string;
  cases: readonly EvalCase[];
  registry?: EnvironmentRegistry;
  // The batch's sealed environments, when this is an execution lane re-deriving what submit pinned. Absent =
  // this IS the sealing moment.
  sealed?: Record<string, SealedEnvironmentEntry>;
}): Promise<ResolvedCaseEnvironments> {
  const referencing = input.cases.filter((c) => c.env.kind === "ref");
  if (referencing.length === 0) return { cases: [...input.cases], seals: {} };
  const registry = input.registry;
  if (registry === undefined)
    throw new BadRequestError(
      "NOT_CONFIGURED",
      { cases: referencing.map((c) => c.id).slice(0, 5) },
      "these cases name their environment by reference and this deployment has no environment registry — register the environment, or embed the environment in the case",
    );
  const seals: Record<string, SealedEnvironmentEntry> = {};
  const cases: EvalCase[] = [];
  // ── ONE READ PER DISTINCT REFERENCE, AND ONE ANSWER FOR THE WHOLE BATCH ────────────────────────────
  //
  // Not merely a saved round trip. A `latest` ref resolved per CASE is resolved several hundred times over
  // the seconds a large dataset takes to seal, and a registration landing in that window would give two cases
  // of one batch two different worlds — recorded honestly by the per-case seal, and then refused by the
  // campaign's "ran N versions at once" check, for a batch nobody meant to split. Memoizing by the ref as
  // ASKED makes the whole submit see one answer.
  const reads = new Map<string, Promise<EnvironmentSpec>>();
  const readOnce = (id: string, version?: string): Promise<EnvironmentSpec> => {
    const key = `${id}@${version ?? "latest"}`;
    const pending = reads.get(key) ?? registry.get(input.tenant, id, version);
    reads.set(key, pending);
    return pending;
  };
  for (const c of input.cases) {
    if (c.env.kind !== "ref") {
      cases.push(c);
      continue;
    }
    const declared = c.env;
    const pinned = input.sealed?.[c.id];
    if (input.sealed !== undefined && pinned === undefined)
      throw new ConflictError(
        "CONFLICT",
        { case: c.id, environment: declared.id },
        `case '${c.id}' references environment '${declared.id}' and this batch sealed no environment for it — the selection no longer matches what was sealed`,
      );
    // The version to read: the sealed one when there is a seal, else the declared ref (`latest` allowed).
    const version = pinned !== undefined ? refVersion(pinned.ref) : declared.version;
    const spec: EnvironmentSpec = await readOnce(declared.id, version);
    const digest = contentDigest(spec);
    if (pinned !== undefined && pinned.digest !== undefined && pinned.digest !== digest)
      throw new ConflictError(
        "CONFLICT",
        { case: c.id, environment: `${spec.id}@${spec.version}`, sealed: pinned.digest, read: digest },
        `environment '${spec.id}@${spec.version}' no longer holds the bytes this batch sealed — a registry version is immutable, so this batch cannot be run against what it measured`,
      );
    // The world's BYTES travel with the world (world-and-engagement-model.md, axis 1). A case that also
    // names an image for the same world is refused here rather than resolved by precedence — both readings
    // are defensible from the outside, and picking one silently decides which experiment ran.
    const imageDefect = caseEnvironmentImageDefect(c, spec);
    if (imageDefect !== undefined)
      throw new ConflictError("CONFLICT", { case: c.id, environment: `${spec.id}@${spec.version}` }, imageDefect);
    seals[c.id] = { ref: `${spec.id}@${spec.version}`, digest };
    // WHERE the world is, when it is one the actor reaches by coordinates rather than by being inside it
    // (world-and-engagement-model.md). Platform-authored from the version this batch sealed, so the
    // coordinates and the identity axis are the same fact — and built ONCE here rather than per arm, so a
    // world's own account (`observe`) reaches a static, a session and a created world alike.
    const provides = spec.provides;
    const world =
      provides === undefined
        ? undefined
        : {
            ...(provides.kind === "static"
              ? { wiring: provides.wiring }
              : provides.kind === "session"
                ? {
                    // Opened per case at DISPATCH: this resolution runs once per batch, and a session
                    // acquired at submit would be held for every case after it and expire under most of them.
                    wiring: {},
                    session: { endpoint: provides.endpoint, acquire: provides.acquire },
                  }
                : {
                    // Created per case at dispatch for the same reason — and torn down after it, which is the
                    // half this arm owes and the other two do not.
                    wiring: {},
                    create: {
                      environment: `${spec.id}@${spec.version}`,
                      services: provides.services,
                      wiring: provides.wiring,
                    },
                  }),
            ...(spec.observe !== undefined ? { observe: spec.observe } : {}),
          };
    cases.push({
      ...c,
      env: spec.env,
      ...(spec.image !== undefined ? { image: spec.image } : {}),
      ...(world !== undefined ? { world } : {}),
    });
  }
  return { cases, seals };
}

// "id@version" → the version half. The seal is written by the function above, so a ref with no `@` is a
// corrupted seal rather than a caller's mistake — refuse it instead of resolving `latest` behind its back.
function refVersion(ref: string): string {
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at === ref.length - 1)
    throw new BadRequestError(
      "BAD_REQUEST",
      { ref },
      `sealed environment ref '${ref}' is not "id@version" — the batch's seal cannot be re-resolved`,
    );
  return ref.slice(at + 1);
}

// The single-run adapter (`POST /runs` carries one inline case). One owner above, one thin wrapper here — a
// second resolution written for the single-run lane is the divergence rule `protocol` L3 names.
export async function resolveOneCaseEnvironment(input: {
  tenant: string;
  case: EvalCase;
  registry?: EnvironmentRegistry;
}): Promise<EvalCase> {
  const { cases } = await resolveCaseEnvironments({
    tenant: input.tenant,
    cases: [input.case],
    ...(input.registry ? { registry: input.registry } : {}),
  });
  const [only] = cases;
  if (only === undefined)
    throw new InternalError(
      "UPSTREAM_ERROR",
      { case: input.case.id },
      "the environment resolver returned nothing for one case — an exhaustiveness assertion, not a reachable state",
    );
  return only;
}
