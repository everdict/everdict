import { describe, expect, it } from "vitest";
import { TraceEventSchema, stamp } from "./trace.js";

// `stamp` is the one way an emitter mints an event's time, so it must never be the thing that kills a run:
// a clock it cannot turn into a date costs the event its place on the axis, not the harness its process.
describe("stamping an event's time", () => {
  it("carries both the emitter's scalar and the absolute instant a reader can place it at", () => {
    const ms = Date.parse("2026-08-03T06:26:56.416Z");
    expect(stamp(() => ms)).toEqual({ t: ms, at: "2026-08-03T06:26:56.416Z" });
  });

  it("keeps the event usable when the clock is not a wall clock", () => {
    expect(stamp(() => Number.NaN)).toEqual({ t: Number.NaN });
    expect(stamp(() => 8.7e15)).toEqual({ t: 8.7e15 }); // outside the Date range — ordinal only, no throw
  });

  it("produces a stamp the trace schema accepts as-is", () => {
    const event = { ...stamp(() => 1_700_000_000_000), kind: "message", role: "assistant", text: "done" };
    expect(TraceEventSchema.parse(event)).toMatchObject({ at: "2023-11-14T22:13:20.000Z" });
  });
});
