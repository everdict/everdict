import type { TrackEntry } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryRecordingStore } from "./recording-store.js";

describe("InMemoryRecordingStore", () => {
  it("returns undefined for a recording that was never sealed", async () => {
    // Given a store with only appended (in-progress) entries
    const store = new InMemoryRecordingStore();
    await store.append("run-1", { track: "logs", entry: { t: 1, stream: "stdout", text: "start" } });
    // When/Then an unsealed recording is not yet a complete CaseRecording
    expect(await store.get("run-1")).toBeUndefined();
  });

  it("accumulates track entries in order and seals them into a CaseRecording", async () => {
    // Given frames, logs and a runtime sample appended across a run
    const store = new InMemoryRecordingStore();
    const entries: TrackEntry[] = [
      { track: "frames", entry: { t: 1000, ref: "memory://f1" } },
      { track: "logs", entry: { t: 1010, stream: "stdout", text: "step 1" } },
      { track: "frames", entry: { t: 2000, ref: "memory://f2" } },
      { track: "runtime", entry: { t: 1500, memBytes: 128 } },
    ];
    for (const entry of entries) await store.append("run-1", entry);

    // When the recording is sealed with its clock/kind/fidelity + audit manifest
    const ref = await store.seal("run-1", {
      t0: 1000,
      envKind: "browser",
      effectiveFidelity: "frames",
      dispatch: { harness: "claude-code@1.0.0" },
    });

    // Then the ref points at the recording and get() returns the assembled, ordered tracks
    expect(ref.ref).toBe("memory://recording/run-1");
    const rec = await store.get("run-1");
    expect(rec?.t0).toBe(1000);
    expect(rec?.envKind).toBe("browser");
    expect(rec?.effectiveFidelity).toBe("frames");
    expect(rec?.tracks.frames?.map((f) => f.ref)).toEqual(["memory://f1", "memory://f2"]);
    expect(rec?.tracks.logs?.[0]?.text).toBe("step 1");
    expect(rec?.tracks.runtime?.[0]?.memBytes).toBe(128);
    expect(rec?.dispatch?.harness).toBe("claude-code@1.0.0");
  });

  it("keeps recordings separate per runId", async () => {
    // Given entries for two runs
    const store = new InMemoryRecordingStore();
    await store.append("run-a", { track: "frames", entry: { t: 1, ref: "memory://a" } });
    await store.append("run-b", { track: "frames", entry: { t: 1, ref: "memory://b" } });
    await store.seal("run-a", { t0: 0, envKind: "os-use", effectiveFidelity: "frames" });
    await store.seal("run-b", { t0: 0, envKind: "os-use", effectiveFidelity: "frames" });

    // Then each recording holds only its own frames
    expect((await store.get("run-a"))?.tracks.frames?.map((f) => f.ref)).toEqual(["memory://a"]);
    expect((await store.get("run-b"))?.tracks.frames?.map((f) => f.ref)).toEqual(["memory://b"]);
  });
});
