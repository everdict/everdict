import type { JudgeSpec, JudgeSpecDiff } from "@everdict/contracts";
import { diffSpecFields, summarizeSpecChanges } from "../spec-diff.js";

// Top-level keys excluded from the diff — id is identical by construction, version differs trivially between two versions.
const IGNORED_TOP_LEVEL = new Set(["id", "version"]);

// base ↔ candidate JudgeSpec diff. Reports leaf field changes by path (model/provider/rubric/inputs/passThreshold/
// criteria/promptTemplate/harness/runtime), excluding the trivially-differing id/version keys. kindChanged flags a
// model↔harness restructure. Uses the shared spec-diff engine (see spec-diff.ts).
export function diffJudgeSpecs(base: JudgeSpec, candidate: JudgeSpec): JudgeSpecDiff {
  const changes = diffSpecFields(
    base as Record<string, unknown>,
    candidate as Record<string, unknown>,
    IGNORED_TOP_LEVEL,
  );
  return {
    id: candidate.id,
    base: base.version,
    candidate: candidate.version,
    kindChanged: base.kind !== candidate.kind,
    changes,
    summary: summarizeSpecChanges(changes),
  };
}
