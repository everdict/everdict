import { type CaseJob, type CaseResult, UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { executeWithOomBoost } from "./oom-boost.js";
import type { SpilloverOutcome } from "./runtime-spillover.js";

const job = (memoryMb: number): CaseJob => ({
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  },
  harness: { id: "h", version: "1" },
  harnessSpec: {
    kind: "command",
    id: "h",
    version: "1",
    command: "run",
    setup: [],
    env: {},
    params: {},
    trace: { kind: "none" },
    resources: { memoryMb },
  },
  tenant: "acme",
  recordingGeneration: 1,
});

const ok: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
};

const oom = new UpstreamError("UPSTREAM_ERROR", { signal: "OOM_KILLED" }, "container OOM-killed");

describe("executeWithOomBoost — a boosted re-run is a new physical attempt", () => {
  it("opens a fresh recording generation for the boosted dispatch and returns the winner's job", async () => {
    let opened = 0;
    const seen: Array<{ mb: number | undefined; generation: number | undefined }> = [];
    const run = async (j: CaseJob): Promise<SpilloverOutcome> => {
      seen.push({
        mb: j.harnessSpec?.kind === "command" ? j.harnessSpec.resources?.memoryMb : undefined,
        generation: j.recordingGeneration,
      });
      if ((j.harnessSpec?.kind === "command" ? (j.harnessSpec.resources?.memoryMb ?? 0) : 0) < 2048) throw oom;
      return { result: ok, job: j };
    };
    const outcome = await executeWithOomBoost(run, job(1024), {
      enabled: true,
      reattempt: async (j) => ({ ...j, recordingGeneration: 20 + ++opened }),
    });
    expect(seen).toEqual([
      { mb: 1024, generation: 1 }, // the OOM-killed attempt keeps its own evidence buffer…
      { mb: 2048, generation: 21 }, // …and the boosted re-run writes into a fresh one
    ]);
    expect(outcome.job.recordingGeneration).toBe(21);
  });
});
