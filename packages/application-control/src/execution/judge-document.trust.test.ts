import type { JudgeSpec, Score } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import { ScoringService } from "./scoring-service.js";

// Trust suite (docs/trust-certification.md) — TRUST-76.
//
// A PASS JUDGES THE DOCUMENT IT SEALED, OR IT DOES NOT JUDGE.
//
// The top-level batch documents were given this check first; the judges are the same shape one level in. Every
// pass re-reads `judges.get(tenant, id, version)`, and that lookup is owner-first over a `_shared` fallback —
// so a workspace registering its own `quality@1` after the pass claimed hands the executor a DIFFERENT rubric,
// prompt and criteria under a held name, while the ScoringRevision keeps recording the closure of the document
// it sealed. The digest was already being sealed; nothing consumed it.
//
// The refusal is an UNRESOLVED SELECTION rather than a thrown pass, deliberately: the stream turns each
// unresolved judge into a visible per-case unmeasured row, so the batch settles carrying no verdict from that
// judge — honest, and recoverable by a new pass — instead of judging under a document nobody certified.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const judgeSpec = (rubric: string): JudgeSpec => ({
  kind: "model",
  id: "quality",
  version: "1.0.0",
  provider: "anthropic",
  model: "m",
  rubric,
  inputs: ["trace"],
  tags: [],
});

const service = (served: JudgeSpec) =>
  new ScoringService({
    judges: {
      async get() {
        return served;
      },
    } as unknown as JudgeRegistry,
    judgeRunner: {
      async run(): Promise<Score[]> {
        throw new Error("the provider must never be reached for a shadowed document");
      },
    } as unknown as JudgeRunner,
  });

describeTrust("TRUST-76 — a shadowed judge document is refused before the provider is called", () => {
  const sealedDoc = judgeSpec("did it book the flight?");
  const sealed = [{ id: "quality", version: "1.0.0", specDigest: contentDigest(sealedDoc) }];

  it("resolves normally when the document is the one the pass sealed", async () => {
    const { specs, unresolved } = await service(sealedDoc).resolveJudges(
      "acme",
      [{ id: "quality", version: "1.0.0" }],
      sealed,
    );
    expect(unresolved).toEqual([]);
    expect(specs).toHaveLength(1);
  });

  it("refuses when the SAME id@version now resolves to different bytes", async () => {
    // Same id, same version string — a workspace-local registration shadowing the shared one. The rubric is
    // the whole question being asked, so this is a different judge wearing a held name.
    const shadowed = judgeSpec("did it book ANY trip?");
    const { specs, unresolved } = await service(shadowed).resolveJudges(
      "acme",
      [{ id: "quality", version: "1.0.0" }],
      sealed,
    );
    expect(specs).toEqual([]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.message).toContain("sealed by this pass");
  });

  it("a pass with no sealed digest verifies nothing rather than refusing everything", async () => {
    // Absence is a generation gap — a marker sealed before closures recorded the document digest. Refusing
    // would strand every in-flight legacy pass at the moment of deploy.
    const { unresolved } = await service(judgeSpec("anything")).resolveJudges(
      "acme",
      [{ id: "quality", version: "1.0.0" }],
      [{ id: "quality", version: "1.0.0" }],
    );
    expect(unresolved).toEqual([]);
  });
});
