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
  deps: Pick<ScorecardServiceDeps, "judges" | "resolveModelBinding" | "rubrics" | "harnesses">,
  tenant: string,
  judges: Array<{ id: string; version: string }>,
): Promise<
  Array<{ id: string; version: string; specDigest?: string; model?: string; rubric?: string; harness?: string }>
> {
  const out: Array<{
    id: string;
    version: string;
    specDigest?: string;
    model?: string;
    rubric?: string;
    harness?: string;
  }> = [];
  for (const j of judges) {
    try {
      const spec = await deps.judges?.get(tenant, j.id, j.version);
      const binding = spec !== undefined && "model" in spec ? spec.model : undefined;
      const model =
        binding === undefined ? undefined : ((await sealedModelIdentity(deps, tenant, binding)) ?? "unresolved");
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
        ...(rubric ? { rubric } : {}),
        ...(harness ? { harness } : {}),
      });
    } catch {
      out.push({ id: j.id, version: j.version });
    }
  }
  return out;
}

// Seal one versioned reference: an explicit pin is already concrete (registry versions are immutable — the
// pin names one document forever); a "latest" ref resolves to the concrete version NOW, or seals the honest
// "unresolved" sentinel when no registry (or no such entry) can answer.
async function sealVersionedRef(
  ref: { id: string; version?: string },
  registry: { get(tenant: string, id: string, version: string): Promise<{ version: string }> } | undefined,
  tenant: string,
): Promise<string> {
  const version = ref.version || "latest";
  if (version !== "latest") return `${ref.id}@${version}`;
  if (!registry) return "unresolved";
  try {
    const resolved = await registry.get(tenant, ref.id, version);
    return `${ref.id}@${resolved.version}`;
  } catch {
    return "unresolved";
  }
}
