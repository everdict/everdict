import { AppError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { keysFor, perRunFields, perRunVocabulary, wiringVars } from "./environment-manager.js";

describe("perRun vocabulary + field injection", () => {
  const runId = "abc";
  const keys = keysFor(runId);
  // A thread_id-isolated dependency contributes thread_id to the wiring; task/target are caller extras.
  const wiring = wiringVars(runId, [{ store: "postgres", role: "checkpoint", isolateBy: "thread_id" }], {
    task: "do it",
    target_cdp_url: "ws://browser:9222",
  });
  const vocab = perRunVocabulary(keys, wiring);

  it("spans both the isolateBy wiring and the keysFor default-body names (so historic perRun keys resolve)", () => {
    // stream_channel/minio_prefix come from keysFor, NOT wiringVars — perRun must still resolve them (bu.template uses them).
    expect(vocab.thread_id).toBe(`run-${runId}`);
    expect(vocab.stream_channel).toBe(keys.streamChannel);
    expect(vocab.minio_prefix).toBe(keys.minioPrefix);
    expect(vocab.run_id).toBe(runId);
    expect(vocab.task).toBe("do it");
    expect(vocab.target_cdp_url).toBe("ws://browser:9222");
  });

  it("injects each declared per-run key from the vocabulary", () => {
    expect(perRunFields(["thread_id", "stream_channel", "target_cdp_url"], vocab, "agent")).toEqual({
      thread_id: `run-${runId}`,
      stream_channel: keys.streamChannel,
      target_cdp_url: "ws://browser:9222",
    });
  });

  it("returns nothing for an empty perRun (no injection, no error)", () => {
    expect(perRunFields([], vocab, "agent")).toEqual({});
  });

  it("fails fast (config error) when a declared per-run key has no value in the vocabulary", () => {
    // Realizes perRun as a validated contract: an undeliverable per-run coordinate is surfaced, never silently dropped.
    try {
      perRunFields(["nonexistent_coord"], vocab, "agent");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as Error).message).toMatch(/per-run input "nonexistent_coord"/);
    }
  });
});
