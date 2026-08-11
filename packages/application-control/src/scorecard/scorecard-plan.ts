import {
  AppError,
  BadRequestError,
  type HarnessSpec,
  type ModelBinding,
  NotFoundError,
  type SealedJudgeEntry,
} from "@everdict/contracts";
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
//
// It is the RECORD's shape, not a local restatement of it (arch-review 20 P0-3). This interface was a third
// spelling of the same closure, and a third spelling is a third place to forget a field: the sealer grew
// `harnessModelDigest`, produced it, and the type it declared its own return under had never heard of it. One
// schema, one type, one meaning — everywhere the closure travels.
export type { SealedJudgeEntry };

// ONE READ, ONE DECISION (arch-review 20 P1). A model pin is a ref AND the digest of the document that ref
// named, and the first version produced them from two separate registry reads — `resolveModelBinding` for the
// version, then a second `get` for the bytes. Between them the registry can move, so the seal could record an
// IMPOSSIBLE PAIR: `model-x@1` beside the digest of `model-x@2`. Nothing downstream could ever satisfy it, and
// the refusal it produced would name a drift that never happened.
//
// The rubric and delegated-harness helpers already had this shape — one read, both facets off the same object.
// The model path now matches them.
// A REGISTRY DOCUMENT A RESOLUTION READ, named by what a fence can key on. Kind and id only — the generation
// table is keyed by name, because owner-first resolution means the NAME is what a concurrent registration
// changes, not the version that was chosen last time.
export interface ClosureDocument {
  kind: "model" | "rubric" | "harness";
  id: string;
}

export async function resolveModelPin(
  deps: Pick<ScorecardServiceDeps, "models" | "resolveModelBinding">,
  tenant: string,
  binding: ModelBinding,
): Promise<{ ref: string; digest?: string; unreadable?: true; document?: ClosureDocument }> {
  // WHETHER A DOCUMENT IS BEHIND THIS REF IS KNOWN HERE AND NOWHERE ELSE (arch-review 24). The sealed ref is
  // a string, so every later reader had to guess the answer from its shape — "does it contain an `@`" — and a
  // literal model name carrying one would be fenced as a registry document while the vocabulary of the
  // decision quietly became a spelling convention. The binding's TYPE is the fact; it is carried, not
  // re-derived. Only kind and id: the generation table is keyed by name, and it is the NAME whose resolution
  // can change under a decision.
  if (typeof binding === "string") return { ref: binding }; // a literal — no document, nothing to fence
  if (deps.models) {
    try {
      const spec = await deps.models.get(tenant, binding.ref, binding.version ?? "latest");
      return {
        ref: `${binding.ref}@${spec.version}`,
        digest: contentDigest(spec),
        document: { kind: "model", id: binding.ref },
      };
    } catch {
      // A ref WITH a reader that could not read it is a third state, and the two consumers want opposite
      // things from it (arch-review 21 P1). The manifest records the run that happened, so it keeps the ref
      // and says the document was never verified; the release gate is asking whether today's identity is
      // established, and a hole is not an answer. Saying which case this is lets each apply its own policy
      // instead of both inheriting the weaker one.
      // Unreadable, and still a NAME — the document it names is exactly the one whose resolution a
      // concurrent registration could change, so it stays in the read-set.
      return {
        ref: (await sealedModelIdentity(deps, tenant, binding)) ?? "unresolved",
        unreadable: true,
        document: { kind: "model", id: binding.ref },
      };
    }
  }
  return {
    ref: (await sealedModelIdentity(deps, tenant, binding)) ?? "unresolved",
    document: { kind: "model", id: binding.ref },
  };
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
//
// TWO POLICIES OVER ONE RESOLUTION (arch-review 22 P0-4): the entries are what the manifest records — holes
// included, because a manifest states what HAPPENED — and `holes` is what a strict reader needs, because a
// ref whose document could not be read is not an identity anyone can call established. They were the same
// lossy answer before, so the release gate inherited the sealer's best-effort policy: an explicit `rubric@1`
// that nobody could read looked exactly like a verified one, and two evaluations sharing that hole compared
// EQUAL — unknown ≡ unknown reading as "the question has not moved".
export async function sealJudgeClosureWithHoles(
  deps: Pick<ScorecardServiceDeps, "judges" | "resolveModelBinding" | "rubrics" | "harnesses" | "models">,
  tenant: string,
  judges: Array<{ id: string; version: string }>,
): Promise<{ entries: Array<SealedJudgeEntry>; holes: string[]; documents: ClosureDocument[] }> {
  const out: Array<SealedJudgeEntry> = [];
  const holes: string[] = [];
  // Every registry document this closure READ, collected as it is read (arch-review 24). The release fence
  // needs the closure's read-set, and re-deriving it from the sealed strings is the reconstruction this
  // generation of review keeps removing: the resolver knows, so the resolver says.
  const documents: ClosureDocument[] = [];
  for (const j of judges) {
    const at = `judge '${j.id}@${j.version}'`;
    try {
      const spec = await deps.judges?.get(tenant, j.id, j.version);
      const binding = spec !== undefined && "model" in spec ? spec.model : undefined;
      // The ref AND the DOCUMENT beneath it, from ONE read (arch-review 19 P0-4, 20 P1). `model-x@1` names
      // whichever namespace answers, and the model spec carries the provider, the underlying model name, the
      // base URL and the key secret — every one of which changes what the judge actually is.
      const modelPin = binding === undefined ? undefined : await resolveModelPin(deps, tenant, binding);
      if (modelPin?.document) documents.push(modelPin.document);
      const model = modelPin?.ref;
      const modelDigest = modelPin?.digest;
      const rubricRef =
        spec !== undefined && "rubric" in spec && spec.rubric !== undefined && typeof spec.rubric !== "string"
          ? spec.rubric
          : undefined;
      const rubric = rubricRef === undefined ? undefined : await sealVersionedRef(rubricRef, deps.rubrics, tenant);
      if (rubricRef !== undefined) documents.push({ kind: "rubric", id: rubricRef.id });
      const harnessRef = spec !== undefined && spec.kind === "harness" ? spec.harness : undefined;
      const harness = harnessRef === undefined ? undefined : await sealVersionedRef(harnessRef, deps.harnesses, tenant);
      if (harnessRef !== undefined) documents.push({ kind: "harness", id: harnessRef.id });
      // …AND THE DELEGATED HARNESS'S OWN MODEL CLOSURE (arch-review 20 P0-4, the last level of the
      // recursion). Pinning the harness document proves the agent is the one we sealed; that document then
      // names its own `{ref}` model bindings, which resolve at the judge's dispatch through the same
      // owner-first lookup. Without this the delegated agent is verified and the model it thinks with is not.
      const delegatedClosure =
        harness?.document === undefined ? undefined : await sealHarnessModelClosure(deps, tenant, harness.document);
      documents.push(...(delegatedClosure?.documents ?? []));
      if (modelPin?.unreadable) holes.push(`${at} names a model document that could not be read`);
      if (rubric?.unreadable) holes.push(`${at} names a rubric document that could not be read`);
      if (harness?.unreadable) holes.push(`${at} names a delegated harness document that could not be read`);
      for (const facet of delegatedClosure?.unreadable ?? [])
        holes.push(`${at}'s delegated harness names a ${facet} document that could not be read`);
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
        ...(delegatedClosure?.modelDigest ? { harnessModelDigest: delegatedClosure.modelDigest } : {}),
        ...(delegatedClosure?.serviceModelDigests
          ? { harnessServiceModelDigests: delegatedClosure.serviceModelDigests }
          : {}),
      });
    } catch {
      out.push({ id: j.id, version: j.version });
      holes.push(`${at} could not be read`);
    }
  }
  return { entries: out, holes, documents };
}

// The manifest's view: entries only. A hole is recorded honestly (an absent digest) and the batch still runs,
// because refusing to record would lose the run entirely.
export async function sealJudgeClosure(
  deps: Pick<ScorecardServiceDeps, "judges" | "resolveModelBinding" | "rubrics" | "harnesses" | "models">,
  tenant: string,
  judges: Array<{ id: string; version: string }>,
): Promise<Array<SealedJudgeEntry>> {
  return (await sealJudgeClosureWithHoles(deps, tenant, judges)).entries;
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
  // WHICH facets named a document nobody could read (arch-review 22 P0-4). The manifest ignores this — it
  // records what happened, holes included — and the release gate refuses on it, because a ref it cannot
  // verify is not an identity it can call current. Dropping it here made the two policies share the
  // sealer's weaker one.
  unreadable?: string[];
  // The registry documents this closure read — the fence's read-set, stated by the resolver.
  documents?: ClosureDocument[];
}> {
  if (spec === undefined) return {};
  if (spec.kind === "command") {
    if (spec.model === undefined) return {};
    const pin = await resolveModelPin(deps, tenant, spec.model);
    return {
      model: pin.ref,
      ...(pin.digest ? { modelDigest: pin.digest } : {}),
      ...(pin.unreadable ? { unreadable: ["model"] } : {}),
      ...(pin.document ? { documents: [pin.document] } : {}),
    };
  }
  if (spec.kind === "service") {
    const serviceModels: Record<string, string> = {};
    const serviceModelDigests: Record<string, string> = {};
    const unreadable: string[] = [];
    const documents: ClosureDocument[] = [];
    for (const s of spec.services) {
      if (s.model === undefined) continue;
      // Per service, from ONE read each: a topology's binding is the same owner-first ref as any other, and
      // the service that runs the case is whichever document answers.
      const pin = await resolveModelPin(deps, tenant, s.model);
      serviceModels[s.name] = pin.ref;
      if (pin.digest) serviceModelDigests[s.name] = pin.digest;
      if (pin.unreadable) unreadable.push(`service '${s.name}' model`);
      if (pin.document) documents.push(pin.document);
    }
    return {
      ...(Object.keys(serviceModels).length > 0 ? { serviceModels } : {}),
      ...(Object.keys(serviceModelDigests).length > 0 ? { serviceModelDigests } : {}),
      ...(unreadable.length > 0 ? { unreadable } : {}),
      ...(documents.length > 0 ? { documents } : {}),
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
// The DOCUMENT comes back too, so a caller that needs to look INSIDE it (a delegated harness has its own
// model bindings) does not pay for a second read — and, more to the point, does not seal a digest from one
// read beside a closure derived from another (arch-review 20 P1).
async function sealVersionedRef<T extends { version: string }>(
  ref: { id: string; version?: string },
  registry: { get(tenant: string, id: string, version: string): Promise<T> } | undefined,
  tenant: string,
): Promise<{ ref: string; digest?: string; document?: T; unreadable?: true }> {
  const version = ref.version || "latest";
  if (!registry) return { ref: version === "latest" ? "unresolved" : `${ref.id}@${version}`, unreadable: true };
  try {
    const resolved = await registry.get(tenant, ref.id, version);
    return { ref: `${ref.id}@${resolved.version}`, digest: contentDigest(resolved), document: resolved };
  } catch {
    // A ref that names a document nobody can read pins nothing. For an explicit version the REF still states
    // what was asked for — the missing digest is what tells a later reader it was never verified.
    //
    // …and `unreadable` is what tells the STRICT reader (arch-review 22 P0-4). The two consumers want
    // opposite things from this state and used to share one lossy answer: the manifest records the run that
    // happened, so an explicit `rubric@1` with no digest is honest history; the release gate is asking
    // whether today's identity is ESTABLISHED, and it could not tell that ref apart from a verified one.
    // Two evaluations with the same unverifiable hole then compared EQUAL — unknown ≡ unknown reading as
    // "still current".
    return { ref: version === "latest" ? "unresolved" : `${ref.id}@${version}`, unreadable: true };
  }
}
