import type { SeedReader } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { skillSeedDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { SeedingDispatcher } from "./seeding-dispatcher.js";

// ── THE SEEDS TRAVEL WITH THE JOB (harness-identity-and-seeds-spec.md §2) ────────────────────────────
describe("SeedingDispatcher", () => {
  const skill = { instructions: "# Triage", files: [] };
  const reader: SeedReader = {
    async skillVersion(_t, id, version) {
      return id === "triage" && version === "1.0.0" ? skill : undefined;
    },
    async knowledgeEntry() {
      return undefined;
    },
  };
  const job = (over: Partial<CaseJob>): CaseJob =>
    ({
      evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60 },
      harness: { id: "h", version: "1.0.0" },
      tenant: "acme",
      ...over,
    }) as unknown as CaseJob;
  const seen: CaseJob[] = [];
  const inner = {
    async dispatch(j: CaseJob) {
      seen.push(j);
      return { caseId: "c1" } as unknown as CaseResult;
    },
  };
  it("attaches the verified seed files to the job the inner dispatcher receives", async () => {
    const d = new SeedingDispatcher(reader, inner);
    await d.dispatch(
      job({
        harnessSpec: {
          kind: "command",
          id: "h",
          version: "1.0.0",
          command: "x {{task}}",
          seeds: { skills: [{ id: "triage", version: "1.0.0", digest: skillSeedDigest(skill) }], knowledge: [] },
        } as unknown as CaseJob["harnessSpec"],
      }),
    );
    expect(seen.at(-1)?.seedFiles).toEqual([{ path: "/everdict/seeds/skills/triage/SKILL.md", content: "# Triage" }]);
  });
  it("passes a seedless harness through untouched, and refuses seeds on a job with no tenant", async () => {
    const d = new SeedingDispatcher(reader, inner);
    const plain = job({
      harnessSpec: {
        kind: "command",
        id: "h",
        version: "1.0.0",
        command: "x {{task}}",
      } as unknown as CaseJob["harnessSpec"],
    });
    await d.dispatch(plain);
    expect(seen.at(-1)?.seedFiles).toBeUndefined();
    await expect(
      d.dispatch(
        job({
          tenant: undefined,
          harnessSpec: {
            kind: "command",
            id: "h",
            version: "1.0.0",
            command: "x {{task}}",
            seeds: { skills: [{ id: "triage", version: "1.0.0", digest: skillSeedDigest(skill) }], knowledge: [] },
          } as unknown as CaseJob["harnessSpec"],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
