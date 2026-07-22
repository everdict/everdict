import type { EnvironmentRecorder, RecordingSink, TrackEntry } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { NullRecorder } from "./null-recorder.js";

describe("NullRecorder", () => {
  it("caps at final fidelity and emits nothing to the sink", async () => {
    // Given the prompt-environment no-op recorder driven through a full lifecycle
    const recorder: EnvironmentRecorder = new NullRecorder();
    const emitted: TrackEntry[] = [];
    const sink: RecordingSink = {
      emit: (item) => {
        emitted.push(item);
      },
    };

    // When it runs (even at the highest requested fidelity)
    await recorder.start(sink, "full");
    await recorder.checkpoint("tool_call");
    await recorder.stop();

    // Then it advertises `final` as its ceiling and captures nothing beyond the trace
    expect(recorder.capabilities()).toEqual({ maxFidelity: "final", tracks: [] });
    expect(emitted).toEqual([]);
  });
});
