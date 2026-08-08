import { AppError, BadRequestError, type HarnessSpec, NotFoundError } from "@everdict/contracts";

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
