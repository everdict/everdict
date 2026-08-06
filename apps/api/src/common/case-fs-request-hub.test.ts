import { describe, expect, it } from "vitest";
import { CaseFsRequestHub } from "./case-fs-request-hub.js";

describe("CaseFsRequestHub (run-workbench self-hosted rendezvous)", () => {
  it("parks a read, hands it to the runner's poll exactly once, and resolves it with the answer", async () => {
    const hub = new CaseFsRequestHub(5000);
    const parked = hub.request("evd-run-1", { kind: "fsFile", path: "a.py" });

    const drained = hub.pending("evd-run-1");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ kind: "fsFile", path: "a.py" });
    // A repeat poll must not re-run the same request — delivered-once, answer window stays open.
    expect(hub.pending("evd-run-1")).toHaveLength(0);

    const file = { path: "a.py", size: 1, binary: false, truncated: false, content: "x", diff: "" };
    hub.answer("evd-run-1", drained[0]?.id ?? "", { kind: "fsFile", file });
    expect(await parked).toEqual({ kind: "fsFile", file });
  });

  it("times out to undefined when nobody answers (no live case / old runner), and a late answer is a no-op", async () => {
    const hub = new CaseFsRequestHub(20);
    const parked = hub.request("evd-run-2", { kind: "fsTree" });
    const [request] = hub.pending("evd-run-2");
    expect(await parked).toBeUndefined();
    // Answering after the timeout must not throw — the parked side is already gone.
    hub.answer("evd-run-2", request?.id ?? "", { kind: "fsTree" });
    // A different run's poll sees nothing.
    expect(hub.pending("evd-run-2")).toHaveLength(0);
  });
});
