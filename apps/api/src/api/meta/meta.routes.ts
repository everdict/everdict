import type { FastifyInstance } from "fastify";
import { metaDocs } from "./meta.docs.js";

// ── WHAT THIS DEPLOYMENT IS BUILT FROM (DEFAUL-54, docs/specs/deployment-identity-spec.md) ────────────
//
// A deployment's contract is a fact only the deployment knows, and it used to tell nobody. Drift was
// discovered by a defect REAPPEARING — which reads as "the fix did not work", and twice in one day nearly
// re-opened a finding that had shipped hours earlier.
//
// ⚠️ UNAUTHENTICATED, like `/healthz`. A caller that cannot yet tell whether the contract it is about to use
// is current must not need a credential to find out, and the answer is a commit that is already public in the
// repository it names.
//
// ⚠️ NOT ON `/healthz`. That is a liveness probe read on a loop by things that do not care, and overloading it
// makes identity a thing that has to stay cheap forever. One route, one fact.
export function registerMetaRoutes(app: FastifyInstance): void {
  // Read once at module load: the value cannot change while the process lives, and re-reading it per request
  // would invite somebody to think it could.
  const raw = process.env.EVERDICT_BUILD_COMMIT?.trim();
  // ⚠️ ABSENT IS A THIRD VALUE. An image built before this existed — or built without the arg — reports
  // `commit: null`, never the image TAG and never a string like "unknown". The tag is hand-set in a gitignored
  // `.env` and names whatever somebody last typed, so a stamp derived from it could disagree with the bytes;
  // and a caller comparing `"unknown"` to a sha gets a mismatch that means nothing (rule `protocol` L2).
  const commit = raw !== undefined && raw !== "" ? raw : null;
  const startedAt = new Date().toISOString();

  app.get("/deployment", { schema: metaDocs.deployment }, async () => ({ commit, startedAt }));
}
