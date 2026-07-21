import { describe, expect, it } from "vitest";
import { LiveLogStore } from "./live-log-store.js";

describe("LiveLogStore", () => {
  it("accumulates a run's log lines (newline-joined) — cumulative, not overwrite", () => {
    const store = new LiveLogStore();
    store.append("evd-run-1", "▶ Started");
    store.append("evd-run-1", "✓ Completed");
    expect(store.get("evd-run-1")).toBe("▶ Started\n✓ Completed");
    expect(store.get("evd-run-2")).toBeUndefined(); // never pushed
  });

  it("expires an entry after the TTL (dropped on read) so a dead run's log doesn't linger forever", () => {
    let t = 1_000_000;
    const store = new LiveLogStore(900_000, 1000, () => t);
    store.append("r", "line");
    t += 900_001; // just past the 15-min TTL
    expect(store.get("r")).toBeUndefined();
  });

  it("keeps a long-running case's log alive far past its last line (generous TTL, unlike a frame)", () => {
    let t = 0;
    const store = new LiveLogStore(900_000, 1000, () => t);
    store.append("r", "▶ Started");
    t += 600_000; // 10 minutes of a quiet, still-running case
    expect(store.get("r")).toBe("▶ Started"); // still there — logs are cumulative history, not point-in-time
  });

  it("bounds memory with a per-run ring cap — a chatty run drops its oldest lines", () => {
    const store = new LiveLogStore(900_000, 3);
    for (const n of [1, 2, 3, 4, 5]) store.append("r", `line ${n}`);
    expect(store.get("r")).toBe("line 3\nline 4\nline 5"); // only the newest 3 kept
  });
});
