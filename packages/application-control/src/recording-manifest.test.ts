import type { CaseResult, TrackEntry } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { RecordingStore } from "./ports/recording-store.js";
import { foldEnvDeltas } from "./recording-manifest.js";

// A recording store that only captures appends — foldEnvDeltas never seals (that's the caller's next step).
function capturingStore(appended: Array<{ runId: string; item: TrackEntry }>): RecordingStore {
  return {
    append: async (runId: string, item: TrackEntry) => {
      appended.push({ runId, item });
    },
    seal: async () => undefined,
    get: async () => undefined,
  } as unknown as RecordingStore;
}

describe("foldEnvDeltas — in-run env deltas → recording custom lane", () => {
  it("appends each repo-diff delta onto the custom lane and clears them from the result", async () => {
    const appended: Array<{ runId: string; item: TrackEntry }> = [];
    const result = {
      caseId: "c1",
      harness: "h@1",
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "x" },
      scores: [],
      envDeltas: [
        { t: 100, kind: "repo-diff", text: "d1" },
        { t: 200, kind: "repo-diff", text: "d2" },
      ],
    } as unknown as CaseResult;

    await foldEnvDeltas(capturingStore(appended), "evd-run-1", result);

    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      runId: "evd-run-1",
      item: { track: "custom", entry: { t: 100, name: "repo-diff", text: "d1" } },
    });
    expect(appended[1]).toMatchObject({
      item: { track: "custom", entry: { t: 200, name: "repo-diff", text: "d2" } },
    });
    // Folded into the recording → cleared so it is not double-stored on the persisted CaseResult.
    expect(result.envDeltas).toBeUndefined();
  });

  it("is a no-op when the result carries no env deltas", async () => {
    const appended: Array<{ runId: string; item: TrackEntry }> = [];
    const result = {
      caseId: "c1",
      harness: "h@1",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    } as unknown as CaseResult;

    await foldEnvDeltas(capturingStore(appended), "evd-run-1", result);

    expect(appended).toHaveLength(0);
  });
});
