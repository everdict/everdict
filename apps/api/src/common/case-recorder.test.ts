import { InMemoryRecordingStore } from "@everdict/db";
import { InMemoryArtifactStore } from "@everdict/storage";
import { describe, expect, it } from "vitest";
import { CaseRecorder } from "./case-recorder.js";

// A deterministic clock advancing 1s per read (so frame keys/timestamps are predictable).
function fakeClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => {
    const value = t;
    t += 1000;
    return value;
  };
}

describe("CaseRecorder", () => {
  it("offloads a frame to object storage and appends it to the recording", async () => {
    // Given a recorder over in-memory stores
    const recordings = new InMemoryRecordingStore();
    const artifacts = new InMemoryArtifactStore();
    const recorder = new CaseRecorder(recordings, artifacts, fakeClock());
    const attempt = await recordings.open("evd-run-1"); // the dispatch opens it; producers stamp what it returns

    // When a runner reports a frame
    await recorder.recordFrame("evd-run-1", "AAAA", attempt);

    // Then the frame is offloaded (bytes in the artifact store) and appended with an object ref
    await recordings.seal("evd-run-1", { envKind: "browser" }, attempt);
    const rec = await recordings.get("evd-run-1");
    expect(rec?.tracks.frames).toHaveLength(1);
    // …under the ATTEMPT's key: one namespace per physical execution, not per run (review 39, Phase 4).
    expect(rec?.tracks.frames?.[0]?.ref).toMatch(/^memory:\/\/artifacts\/attempts\/evd-run-1#g\d+\/frames\//);
    expect(artifacts.objects.size).toBe(1); // one PNG uploaded
  });

  it("dedups consecutive-identical frames onto a single offloaded object", async () => {
    // Given a static screen reported three times, then a changed frame
    const recordings = new InMemoryRecordingStore();
    const artifacts = new InMemoryArtifactStore();
    const recorder = new CaseRecorder(recordings, artifacts, fakeClock());
    const attempt = await recordings.open("evd-run-1"); // the dispatch opens it; producers stamp what it returns

    await recorder.recordFrame("evd-run-1", "SAME", attempt);
    await recorder.recordFrame("evd-run-1", "SAME", attempt);
    await recorder.recordFrame("evd-run-1", "SAME", attempt);
    await recorder.recordFrame("evd-run-1", "CHANGED", attempt);

    // Then all four frames are recorded (the timeline is complete) but only TWO objects were uploaded
    await recordings.seal("evd-run-1", { envKind: "browser" }, attempt);
    const frames = (await recordings.get("evd-run-1"))?.tracks.frames ?? [];
    expect(frames).toHaveLength(4);
    expect(new Set(frames.map((f) => f.ref)).size).toBe(2); // the 3 identical frames share one ref
    expect(artifacts.objects.size).toBe(2); // no re-upload of the static screen
  });

  it("records log lines onto the logs lane", async () => {
    // Given a runner pushing lifecycle log lines
    const recordings = new InMemoryRecordingStore();
    const recorder = new CaseRecorder(recordings, new InMemoryArtifactStore(), fakeClock());
    const attempt = await recordings.open("evd-run-1"); // the dispatch opens it; producers stamp what it returns

    await recorder.recordLog("evd-run-1", "Started", attempt);
    await recorder.recordLog("evd-run-1", "Completed", attempt);

    // Then they land on the logs track in order
    await recordings.seal("evd-run-1", { envKind: "repo" }, attempt);
    const logs = (await recordings.get("evd-run-1"))?.tracks.logs ?? [];
    expect(logs.map((l) => l.text)).toEqual(["Started", "Completed"]);
  });

  it("records logs without an object store, but skips frames (they need offload)", async () => {
    // Given a recorder with NO artifact store (persistent recording still on; frames just can't offload)
    const recordings = new InMemoryRecordingStore();
    const recorder = new CaseRecorder(recordings, undefined, fakeClock());
    const attempt = await recordings.open("evd-run-1");

    // When both a frame and a log are reported
    await recorder.recordFrame("evd-run-1", "AAAA", attempt);
    await recorder.recordLog("evd-run-1", "Started", attempt);

    // Then the log is recorded and the frame is skipped
    await recordings.seal("evd-run-1", { envKind: "repo" }, attempt);
    const rec = await recordings.get("evd-run-1");
    expect(rec?.tracks.logs?.map((l) => l.text)).toEqual(["Started"]);
    expect(rec?.tracks.frames).toBeUndefined();
  });

  it("appends a prepared deep-track entry (network/console/…) verbatim onto its lane", async () => {
    // Given a recorder and producer-prepared deep-track entries (byte-heavy ones carry an already-offloaded ref)
    const recordings = new InMemoryRecordingStore();
    const recorder = new CaseRecorder(recordings, new InMemoryArtifactStore(), fakeClock());
    const attempt = await recordings.open("evd-run-1"); // the dispatch opens it; producers stamp what it returns

    // When deep tracks are pushed
    await recorder.recordTrack(
      "evd-run-1",
      { track: "network", entry: { t: 5, method: "GET", url: "https://x" } },
      attempt,
    );
    await recorder.recordTrack(
      "evd-run-1",
      { track: "console", entry: { t: 6, level: "error", text: "boom" } },
      attempt,
    );

    // Then each lands on its own lane, appended as-is (no offload)
    await recordings.seal("evd-run-1", { envKind: "browser" }, attempt);
    const rec = await recordings.get("evd-run-1");
    expect(rec?.tracks.network?.[0]?.url).toBe("https://x");
    expect(rec?.tracks.console?.[0]?.text).toBe("boom");
  });

  it("swallows an artifact-store failure so a recording error never affects the run", async () => {
    // Given an artifact store that throws on put
    const recordings = new InMemoryRecordingStore();
    const brokenArtifacts = {
      async put(): Promise<string> {
        throw new Error("s3 down");
      },
      async get(): Promise<Uint8Array | undefined> {
        return undefined;
      },
      async publicUrlFor(): Promise<string | undefined> {
        return undefined;
      },
    };
    const recorder = new CaseRecorder(recordings, brokenArtifacts, fakeClock());
    const attempt = await recordings.open("evd-run-1");

    // When a frame is reported, recordFrame resolves (best-effort) without throwing
    await expect(recorder.recordFrame("evd-run-1", "AAAA", attempt)).resolves.toBeUndefined();
    // And nothing was appended (the offload failed before the append). The recording EXISTS — the dispatch
    // opened this attempt — and holds no frames, which is the honest shape: an attempt that recorded nothing
    // is not an attempt that never happened.
    await recordings.seal("evd-run-1", { envKind: "browser" }, attempt);
    expect((await recordings.get("evd-run-1"))?.tracks.frames ?? []).toHaveLength(0);
  });
});
