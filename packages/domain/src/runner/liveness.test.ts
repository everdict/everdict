import { describe, expect, it } from "vitest";
import { RUNNER_ONLINE_WINDOW_MS, isRunnerOnline } from "./liveness.js";

describe("isRunnerOnline", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");

  it("is online when the runner was seen within the window", () => {
    const seen = new Date(now - (RUNNER_ONLINE_WINDOW_MS - 1_000)).toISOString();
    expect(isRunnerOnline(seen, now)).toBe(true);
  });

  it("is offline once the last-seen is older than the window (silent runner)", () => {
    const seen = new Date(now - (RUNNER_ONLINE_WINDOW_MS + 1_000)).toISOString();
    expect(isRunnerOnline(seen, now)).toBe(false);
  });

  it("treats a never-seen runner (paired but its lease loop never started) as offline", () => {
    expect(isRunnerOnline(undefined, now)).toBe(false);
  });

  it("fails closed on a malformed timestamp (offline rather than assumed online)", () => {
    expect(isRunnerOnline("not-a-date", now)).toBe(false);
  });
});
