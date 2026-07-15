import { describe, expect, it } from "vitest";
import { LiveFrameStore } from "./live-frame-store.js";

describe("LiveFrameStore", () => {
  it("returns the latest pushed frame for a run (most recent wins)", () => {
    const store = new LiveFrameStore();
    expect(store.get("evd-run-1")).toBeUndefined();
    store.put("evd-run-1", "AAAA");
    store.put("evd-run-1", "BBBB");
    expect(store.get("evd-run-1")?.frameBase64).toBe("BBBB");
  });

  it("keeps runs separate by id", () => {
    const store = new LiveFrameStore();
    store.put("r1", "AAAA");
    store.put("r2", "CCCC");
    expect(store.get("r1")?.frameBase64).toBe("AAAA");
    expect(store.get("r2")?.frameBase64).toBe("CCCC");
  });

  it("drops a frame once it is older than the TTL (a live screen is only useful while the run is live)", () => {
    let clock = 1000;
    const store = new LiveFrameStore(50, () => clock);
    store.put("r", "AAAA");
    clock = 1040; // still within the 50ms TTL
    expect(store.get("r")?.frameBase64).toBe("AAAA");
    clock = 1101; // past the TTL
    expect(store.get("r")).toBeUndefined();
  });
});
