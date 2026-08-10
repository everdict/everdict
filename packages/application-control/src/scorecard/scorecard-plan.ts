import { AppError, BadRequestError, type HarnessSpec, type ModelBinding, NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { ScorecardServiceDeps } from "./scorecard-deps.js";

// Harness-spec resolution for a batch (review §22): the one non-pure resolution helper the submit paths
// share — everything else that lived beside it moved to its own concern (domain scoring-plan / requests /
// observability / deps).

// Resolving a registered harness's declarative spec fails two very different ways, and the caller must NOT treat them
// alike. NotFoundError = the id/version isn't in the registry: a built-in harness (scripted/claude-code) or an
// unregistered one — correct to proceed with NO spec embedded (the agent knows it by id). Any OTHER error means the
// harness IS registered but its spec failed to resolve (a malformed target/delivery, a bad pin, a missing template).
// Silently swallowing that would dispatch the eval with no harness, or (worse) let an invalid spec reach the runner
// as an opaque "malformed job" — so it is surfaced as a clear 400 at submit/retry instead. `resolve` is a thunk so
// callers pass get() or resolveWithPins(); an undefined return = the built-in / as-given path.
export async function embedHarnessSpec(
  resolve: () => Promise<HarnessSpec>,
  harness: { id: string; version: string },
): Promise<HarnessSpec | undefined> {
  try {
    return await resolve();
  } catch (e) {
    if (e instanceof NotFoundError) return undefined; // not registered → built-in / as-given (no spec embedded)
    if (e instanceof AppError) throw e; // already a typed, client-safe error (e.g. a missing/mismatched pin)
    // A raw resolve failure (e.g. a ZodError from the spec schema) — remap to our error model so monitoring blames us.
    throw new BadRequestError(
      "BAD_REQUEST",
      { harness: `${harness.id}@${harness.version}` },
      `Harness '${harness.id}@${harness.version}' is registered but its spec is invalid: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// One judge's sealed closure — the ref strings a reader compares, and the DOCUMENT digests that make each ref
// verifiable (arch-review 19 P0-4). Digests are optional: absent means the document could not be read at seal
// time, which a verifier treats as "never pinned", never as agreement.
export interface SealedJudgeEntry {
  id: string;
  version: string;
  specDigest?: string;
  model?: string;
  modelDigest?: string;
  rubric?: string;
  rubricDigest?: string;
  harness?: string;
  harnessDigest?: string;
}

// ONE READ, ONE DECISION (arch-review 20 P1). A model pin is a ref AND the digest of the document that ref
// named, and the first version produced them from two separate registry reads — `resolveModelBinding` for the
// version, then a second `get` for the bytes. Between them the registry can move, so the seal could record an
// IMPOSSIBLE PAIR: `model-x@1` beside the digest of `model-x@2`. Nothing downstream could ever satisfy it, and
// the refusal it produced would name a drift that never happened.
//
// The rubric and delegated-harness helpers already had this shape — one read, both facets off the same object.
// The model path now matches them.
async function resolveModelPin(
  deps: Pick<ScorecardServiceDeps, "models" | "resolveModelBinding">,
  tenant: string,
  binding: ModelBinding,
): Promise<{ ref: string; digest?: string }> {
  if (typeof binding === "string") return { ref: binding }; // already concrete — no document behind it
  if (deps.models) {
    try {
      const spec = await deps.models.get(tenant, binding.ref, binding.version ?? "latest");
      return { ref: `${binding.ref}@${spec.version}`, digest: contentDigest(spec) };
    } catch {
      // Fall through: a deployment with no document reader may still answer the ref through the resolver
      // below, and a ref with no digest is the honest "pinned, never verified" state.
    }
  }
  return { ref: (await sealedModelIdentity(deps, tenant, binding)) ?? "unresolved" };
}

// A raw string binding is already concrete; a registry ref resolves to "ref@version" (latest pinned to the
// concrete version at seal time). undefined = no resolver wired or the resolution failed.
export async function sealedModelIdentity(
  deps: Pick<ScorecardServiceDeps, "resolveModelBinding">,
  tenant: string,
  binding: ModelBinding,
): Promise<string | undefined> {
  if (typeof binding === "string") return binding;
  if (!deps.resolveModelBinding) return undefined;
  return await deps.resolveModelBinding(tenant, binding).catch(() => undefined);
}

// Which judge DOCUMENTS score a batch — id + version + spec digest + the sealed closure. ONE sealer shared
// by the submit seal (manifest.judges) and the re-score refresh (a later pass rewriting the same identity),
// so "the judge closure" can never mean two different things on the same record. The spec digest pins bytes;
// the CLOSURE pins what the document's moving references RESOLVED to, because byte-identical specs can still
// judge differently through three run-time resolutions:
//   `model`   — the model binding ("ref@version" after latest-resolution | a raw binding verbatim |
//               "unresolved"; absent = no binding, e.g. harness-delegating)
//   `rubric`  — a rubric REF ("id@version": a latest ref pinned to the concrete version, an explicit pin
//               verbatim since registry versions are immutable | "unresolved"; absent = inline text or no
//               rubric — both already inside specDigest)
//   `harness` — a harness judge's delegated agent, same vocabulary ("id@version" | "unresolved")
// Best-effort per judge: an unresolvable spec keeps its id/version bare rather than failing the pass.
export async function sealJudgeClosure(
  deps: Pick<ScorecardServiceDeps, "judges" | "resolveModelBinding" | "rubrics" | "harnesses" | "models">,
  tenant: string,
  judges: Array<{ id: string; version: string }>,
): Promise<Array<SealedJudgeEntry>> {
  const out: Array<SealedJudgeEntry> = [];
  for (const j of judges) {
    try {
      const spec = await deps.judges?.get(tenant, j.id, j.version);
      const binding = spec !== undefined && "model" in spec ? spec.model : undefined;
      // The ref AND the DOCUMENT beneath it, from ONE read (arch-review 19 P0-4, 20 P1). `model-x@1` names
      // whichever namespace answers, and the model spec carries the provider, the underlying model name, the
      // base URL and the key secret — every one of which changes what the judge actually is.
      const modelPin = binding === undefined ? undefined : await resolveModelPin(deps, tenant, binding);
      const model = modelPin?.ref;
      const modelDigest = modelPin?.digest;
      const rubricRef =
        spec !== undefined && "rubric" in spec && spec.rubric !== undefined && typeof spec.rubric !== "string"
          ? spec.rubric
          : undefined;
      const rubric = rubricRef === undefined ? undefined : await sealVersionedRef(rubricRef, deps.rubrics, tenant);
      const harnessRef = spec !== undefined && spec.kind === "harness" ? spec.harness : undefined;
      const harness = harnessRef === undefined ? undefined : await sealVersionedRef(harnessRef, deps.harnesses, tenant);
      out.push({
        id: j.id,
        version: j.version,
        ...(spec ? { specDigest: contentDigest(spec) } : {}),
        ...(model ? { model } : {}),
        ...(modelDigest ? { modelDigest } : {}),
        ...(rubric?.ref ? { rubric: rubric.ref } : {}),
        ...(rubric?.digest ? { rubricDigest: rubric.digest } : {}),
        ...(harness?.ref ? { harness: harness.ref } : {}),
        ...(harness?.digest ? { harnessDigest: harness.digest } : {}),
      });
    } catch {
      out.push({ id: j.id, version: j.version });
    }
  }
  return out;
}

// The HARNESS model closure (H13 — the judge argument, applied to the treatment): a command harness's
// binding and each service's binding are ModelBindings whose `{ref}` without a version resolves LATEST at
// dispatch, per case — so two batches with byte-identical harness specs (held specDigest) can execute under
// different models. Sealed with the SAME resolution the judge closure uses; the harness stays the treatment,
// so this seal confounds only under a held harness identity (experimentIdentity harness_model axis).
// A process-kind harness carries no binding; absent fields = nothing to seal, never a claim of sameness.
export async function sealHarnessModelClosure(
  deps: Pick<ScorecardServiceDeps, "resolveModelBinding" | "models">,
  tenant: string,
  spec: HarnessSpec | undefined,
): Promise<{
  model?: string;
  serviceModels?: Record<string, string>;
  modelDigest?: string;
  serviceModelDigests?: Record<string, string>;
}> {
  if (spec === undefined) return {};
  if (spec.kind === "command") {
    if (spec.model === undefined) return {};
    const pin = await resolveModelPin(deps, tenant, spec.model);
    return { model: pin.ref, ...(pin.digest ? { modelDigest: pin.digest } : {}) };
  }
  if (spec.kind === "service") {
    const serviceModels: Record<string, string> = {};
    const serviceModelDigests: Record<string, string> = {};
    for (const s of spec.services) {
      if (s.model === undefined) continue;
      // Per service, from ONE read each: a topology's binding is the same owner-first ref as any other, and
      // the service that runs the case is whichever document answers.
      const pin = await resolveModelPin(deps, tenant, s.model);
      serviceModels[s.name] = pin.ref;
      if (pin.digest) serviceModelDigests[s.name] = pin.digest;
    }
    return {
      ...(Object.keys(serviceModels).length > 0 ? { serviceModels } : {}),
      ...(Object.keys(serviceModelDigests).length > 0 ? { serviceModelDigests } : {}),
    };
  }
  return {};
}

// Seal becomes PIN (I6): rewrite the spec's moving model bindings to the closure the manifest sealed, so
// dispatch executes the submit-time resolution instead of re-resolving `latest` per case. Only a `{ref}`
// binding with NO version pins (raw strings and explicit versions are already concrete); a seal that names a
// different ref, or the honest "unresolved" sentinel, pins nothing — the binding stays floating and the
// manifest keeps saying so. The returned spec preserves identity when nothing pins (no gratuitous copies).
export function pinHarnessSpecToClosure(
  spec: HarnessSpec | undefined,
  closure: { model?: string; serviceModels?: Record<string, string> } | undefined,
): HarnessSpec | undefined {
  if (spec === undefined || closure === undefined) return spec;
  if (spec.kind === "command") {
    const pinned = pinModelBinding(spec.model, closure.model);
    return pinned === spec.model ? spec : { ...spec, model: pinned };
  }
  if (spec.kind === "service") {
    let changed = false;
    const services = spec.services.map((s) => {
      const pinned = pinModelBinding(s.model, closure.serviceModels?.[s.name]);
      if (pinned === s.model) return s;
      changed = true;
      return { ...s, model: pinned };
    });
    return changed ? { ...spec, services } : spec;
  }
  return spec;
}

function pinModelBinding(binding: ModelBinding | undefined, sealed: string | undefined): ModelBinding | undefined {
  if (binding === undefined || typeof binding === "string") return binding;
  if (binding.version !== undefined) return binding;
  if (sealed === undefined || sealed === "unresolved") return binding;
  const at = sealed.lastIndexOf("@");
  if (at <= 0 || sealed.slice(0, at) !== binding.ref) return binding;
  return { ...binding, version: sealed.slice(at + 1) };
}

// Seal one versioned reference — its REF and its DOCUMENT (arch-review 19 P0-4).
//
// "An explicit pin is already concrete, because registry versions are immutable" was true of a version inside
// ONE namespace and false of the lookup: resolution is owner-first over a `_shared` fallback, so `rubric-x@1`
// names whichever namespace answers today. A workspace registering its own `rubric-x@1` after the seal hands
// execution a different rubric under a held ref, and a ref-only pin cannot tell — the string is identical.
//
// So the document is fetched even for an explicit pin (that read is exactly what makes the pin verifiable)
// and its digest is sealed beside the ref. `unresolved` keeps its meaning: nothing to pin, honestly said.
async function sealVersionedRef(
  ref: { id: string; version?: string },
  registry: { get(tenant: string, id: string, version: string): Promise<{ version: string }> } | undefined,
  tenant: string,
): Promise<{ ref: string; digest?: string }> {
  const version = ref.version || "latest";
  if (!registry) return { ref: version === "latest" ? "unresolved" : `${ref.id}@${version}` };
  try {
    const resolved = await registry.get(tenant, ref.id, version);
    return { ref: `${ref.id}@${resolved.version}`, digest: contentDigest(resolved) };
  } catch {
    // A ref that names a document nobody can read pins nothing. For an explicit version the REF still states
    // what was asked for — the missing digest is what tells a later reader it was never verified.
    return { ref: version === "latest" ? "unresolved" : `${ref.id}@${version}` };
  }
}
