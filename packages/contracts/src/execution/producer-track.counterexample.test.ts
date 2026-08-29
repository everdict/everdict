import { describe, expect, it } from "vitest";
import { ProducerTrackEntrySchema, TrackEntrySchema } from "./recording.js";

// ── [R122 COUNTEREXAMPLE] A PRODUCER PUSHES BYTES, NOT A FRAME'S COORDINATE ─────────────────────────
//
// `report_case_track` lets a leased self-hosted runner append one prepared replay entry. Its description
// names the tracks it means — "network/console/nav/dom/runtime/custom" — and its `inputSchema` was the WHOLE
// `TrackEntrySchema`, which also carries `{ track: "frames", entry: { ref } }`. The type is what runs.
//
// A frames entry lands in `recording.tracks.frames`, and the run-detail read does this to every one of them:
//
//     minted.set(frame.ref, await this.deps.artifacts.publicUrlFor(frame.ref) ?? frame.ref)
//
// — it RE-SIGNS that key into a browser-facing presigned URL. So a runner could name any object in the
// bucket and be handed a fetchable link to it, and the artifact store is ONE bucket for the deployment. Same
// disclosure as the snapshot refs one wave earlier, through a door that wave did not touch: a presigned URL
// does not bypass `runs:read`, it leaves our authorization behind entirely.
//
//     the entry validates   ≠   the producer may author this coordinate
//
// Frames were never meant to arrive this way and the recorder says so: `recordFrame` takes BASE64 BYTES and
// the platform mints the ref, which is why the comment above `recordTrack` reads "Frames still go through
// recordFrame". The union carrying frames past a producer-facing door is the accident.
//
// Seen RED before the split: the frames entry parsed, so the door accepted a coordinate the producer chose.
const FORGED_FRAME = { track: "frames", entry: { t: 1, ref: "artifact://scorecards/another-workspace/case-1.png" } };

describe("[R122 COUNTEREXAMPLE] the producer-facing track union has no frames", () => {
  it("REFUSES a frames entry — a producer may not name the object we will presign", () => {
    const parsed = ProducerTrackEntrySchema.safeParse(FORGED_FRAME);
    expect(parsed.success, "a producer pushed a frame coordinate we will re-sign").toBe(false);
  });

  it("still accepts every track the door's own description names", () => {
    const accepted = [
      { track: "domEvents", entry: { t: 1, ref: "s3://producer-own/batch.json" } },
      { track: "network", entry: { t: 1, method: "GET", url: "https://x/" } },
      { track: "console", entry: { t: 1, level: "info", text: "hi" } },
    ];
    for (const item of accepted)
      expect(ProducerTrackEntrySchema.safeParse(item).success, `${item.track} was refused`).toBe(true);
  });

  it("the FULL union still carries frames — the platform's own recorder appends them", () => {
    // `recordFrame` offloads base64 bytes and appends the entry it minted. If this stopped parsing, the
    // platform could not write its own frames, which is the opposite failure.
    expect(TrackEntrySchema.safeParse(FORGED_FRAME).success).toBe(true);
  });
});
