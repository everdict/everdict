import type { StoreFixture } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { dispatchManifest } from "./recording-manifest.js";

describe("dispatchManifest", () => {
  it("seals a stable, deterministic fixtures hash when the case has fixtures", () => {
    const fixtures: StoreFixture[] = [
      { store: "postgres", role: "world", seed: { inline: "INSERT INTO t VALUES (1);" } },
    ];
    const m1 = dispatchManifest("h@1", fixtures);
    const m2 = dispatchManifest("h@1", fixtures);
    expect(m1.harness).toBe("h@1");
    expect(m1.fixtures).toBeDefined();
    expect(m1.fixtures).toBe(m2.fixtures);
    expect(m1.fixtures).toHaveLength(32);
  });

  it("changes the hash when the fixtures change (audit sensitivity)", () => {
    const a = dispatchManifest("h@1", [{ store: "postgres", seed: { inline: "A" } }]);
    const b = dispatchManifest("h@1", [{ store: "postgres", seed: { inline: "B" } }]);
    expect(a.fixtures).not.toBe(b.fixtures);
  });

  it("omits fixtures for a case with none — a harness-only manifest", () => {
    expect(dispatchManifest("h@1")).toEqual({ harness: "h@1" });
    expect(dispatchManifest("h@1", [])).toEqual({ harness: "h@1" });
  });
});
