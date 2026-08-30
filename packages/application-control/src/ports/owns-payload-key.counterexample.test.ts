import { describe, expect, it } from "vitest";
import { offloadKey } from "./offloading-trajectory-store.js";
import { ownsPayloadKey } from "./trajectory-store.js";

// ── THE OWNERSHIP JOIN A FORGED REF HAS TO SURVIVE (arch-review 121) ──────────────────────────────────
//
// `artifact://` refs ride on `TraceEvent`, which is the schema a producer's own submissions are validated by,
// so a ref in a record is a string somebody may have authored. `ownsPayloadKey` is the one predicate standing
// between such a string and two effects — a presigned fetch of the bytes, and a sweep that DELETES them — and
// it had no test of its own.
//
// What it must not do is answer "yes" on a key that merely starts the same way. `trajectory-payloads/a/b/c/…`
// is the prefix of (tenant a, run b/c) and equally of (tenant a/b, run c): a string comparison calls both the
// owner. Nothing on this path constrains a workspace id — the repo's only charset guard, `assertFsTenant`,
// belongs to @everdict/storage and is enforced for the filesystem's reasons, not this one.
describe("a trajectory payload key belongs to exactly one (workspace, run)", () => {
  // The production builder, not a hand-written string: a test that spells the key itself cannot see the two
  // sides drift apart.
  const key = offloadKey("acme", "run-1", "agent", "textRef", { text: "hello" });

  it("recognises a key the platform minted for this run", () => {
    expect(key.startsWith("trajectory-payloads/acme/run-1/")).toBe(true);
    expect(ownsPayloadKey(key, "acme", "run-1")).toBe(true);
  });

  it("refuses another workspace's key", () => {
    expect(ownsPayloadKey(offloadKey("rival", "run-1", "agent", "textRef", { text: "x" }), "acme", "run-1")).toBe(
      false,
    );
  });

  it("refuses a sibling run inside the same workspace", () => {
    expect(ownsPayloadKey(offloadKey("acme", "run-2", "agent", "textRef", { text: "x" }), "acme", "run-1")).toBe(false);
  });

  // The confusion the segment comparison exists to refuse. Both spellings render the same path, so a prefix
  // test answers true for a workspace that owns neither the run nor the bytes.
  it("does not let a separator in one identifier claim another's objects", () => {
    const forged = "trajectory-payloads/acme/run-1/agent/deadbeef.textRef";
    expect(forged.startsWith("trajectory-payloads/acme/run-1/")).toBe(true); // the prefix reading says yes…
    expect(ownsPayloadKey(forged, "acme/run-1", "agent")).toBe(false); // …and the owner is not this pair
    expect(ownsPayloadKey(forged, "acme", "run-1/agent")).toBe(false);
  });

  // A handle into somebody else's store entirely — the shape a producer would submit to make us fetch or
  // delete an object we have no relationship with.
  it("refuses a key from another namespace altogether", () => {
    for (const foreign of [
      "secrets/acme/run-1/token",
      "../trajectory-payloads/acme/run-1/agent/x.textRef",
      "trajectory-payloads/acme/run-1",
      "trajectory-payloads/acme/run-1/",
      "",
    ]) {
      expect(ownsPayloadKey(foreign, "acme", "run-1")).toBe(false);
    }
  });

  // An exact-prefix-but-longer identifier: `run-1` must not own `run-10`'s bytes.
  it("does not treat an identifier as owning one it prefixes", () => {
    expect(ownsPayloadKey(offloadKey("acme", "run-10", "agent", "textRef", { text: "x" }), "acme", "run-1")).toBe(
      false,
    );
    expect(ownsPayloadKey(offloadKey("acme-2", "run-1", "agent", "textRef", { text: "x" }), "acme", "run-1")).toBe(
      false,
    );
  });
});
