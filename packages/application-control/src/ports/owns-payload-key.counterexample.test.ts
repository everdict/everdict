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

  // ── AN IDENTIFIER CARRYING THE SEPARATOR ────────────────────────────────────────────────────────
  //
  // Not hypothetical: the OTLP door groups spans by the producer's own `everdict.run_id` attribute and seals
  // a trajectory under it, so a pushed run id is a producer-authored string with no charset rule on it.
  //
  // Unescaped, one address serves two owners — `…/acme/b/c/…` is what (acme, "b/c") mints and what
  // (acme, "b") claims — so run "b" could delete run "b/c"'s evidence at its own retention, and the platform
  // could not read back its own object. Escaping makes the two addresses different.
  it("keeps a run id containing the separator inside its OWN namespace", () => {
    const slashed = offloadKey("acme", "b/c", "agent", "textRef", { text: "x" });
    const sibling = offloadKey("acme", "b", "agent", "textRef", { text: "x" });
    expect(slashed).not.toBe(sibling);

    // Each pair owns its own object and only its own.
    expect(ownsPayloadKey(slashed, "acme", "b/c")).toBe(true);
    expect(ownsPayloadKey(slashed, "acme", "b")).toBe(false);
    expect(ownsPayloadKey(sibling, "acme", "b")).toBe(true);
    expect(ownsPayloadKey(sibling, "acme", "b/c")).toBe(false);
  });

  it("keeps a workspace id containing the separator inside its own namespace", () => {
    const nested = offloadKey("acme/eu", "run-1", "agent", "textRef", { text: "x" });
    expect(ownsPayloadKey(nested, "acme/eu", "run-1")).toBe(true);
    expect(ownsPayloadKey(nested, "acme", "eu")).toBe(false);
    expect(ownsPayloadKey(offloadKey("acme", "eu", "agent", "textRef", { text: "x" }), "acme/eu", "run-1")).toBe(false);
  });

  // The escape is injective, so two different ids cannot render to one address by one of them spelling the
  // other's escape.
  it("does not let an id spell another id's escape sequence", () => {
    const literal = offloadKey("acme", "a%2Fb", "agent", "textRef", { text: "x" });
    const slashed = offloadKey("acme", "a/b", "agent", "textRef", { text: "x" });
    expect(literal).not.toBe(slashed);
    expect(ownsPayloadKey(literal, "acme", "a/b")).toBe(false);
    expect(ownsPayloadKey(slashed, "acme", "a%2Fb")).toBe(false);
  });

  // An ordinary identifier renders EXACTLY as before, so this repairs the broken addresses without moving
  // the working ones — including the `:` that every emitter and most attempt ids carry.
  it("leaves an ordinary identifier's address unchanged", () => {
    // Written out rather than derived, because the point IS the literal spelling: `%`-encoding the whole
    // segment (encodeURIComponent) would turn `judge:quality` into `judge%3Aquality` and orphan every object
    // already stored under it.
    expect(offloadKey("acme", "run-1", "judge:quality", "textRef", { text: "x" })).toMatch(
      /^trajectory-payloads\/acme\/run-1\/judge:quality\/sha256:[0-9a-f]{64}\.textRef$/,
    );
  });

  // The confusion the escape exists to refuse, from the other side: a hand-written key that merely LOOKS
  // like one of ours still has exactly one owner.
  it("does not let a forged path claim two owners", () => {
    const forged = "trajectory-payloads/acme/run-1/agent/deadbeef.textRef";
    expect(ownsPayloadKey(forged, "acme", "run-1")).toBe(true); // the pair the address names…
    expect(ownsPayloadKey(forged, "acme/run-1", "agent")).toBe(false); // …and nobody else
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
