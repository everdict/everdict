import { describe, expect, it } from "vitest";

// ── ONE SUITE, EVERY IMPLEMENTATION (arch-review 53, Wave F) ─────────────────────────────────────────
//
// Every protocol this program introduces is a claim about ALL implementations of a port, and today each
// implementation is tested by its own hand-written file. That is how `onWork` came to be threaded in the
// in-process driver and absent in the Temporal one, and how the K8s and Nomad kills drifted apart before
// Wave 2 pulled them back: nothing forced the same questions to be asked of both.
//
// A conformance suite is a function over an implementation — `describeManagedDispatch(factory)` — that every
// backend runs. Adding a backend then means running the suite, and a protocol change means changing the
// suite once rather than remembering every adapter that implements it.
//
// The five this program needs:
//
//   ManagedDispatchConformance      — identity is durable before the external object exists (Wave A)
//   RuntimeWorkControlConformance   — adopt/logs/exec/inspect/sample address exact work (Wave B)
//   UnknownPropagationConformance   — a failed read is unknown, and unknown never widens scope (Wave A.5)
//   PublicationOperationConformance — one settlement, one operation, claimed by id (Wave C)
//   CancellationVerificationConformance — completion is a readback of zero (Wave E)
//
// The invariant this pins: the suites exist and are exported, so an adapter cannot opt out of a protocol by
// simply not having a test for it.

// Resolved at runtime, not by the module graph: the module does not exist yet, and a static import of a
// missing path is a compile error rather than the failing assertion this file is for.
const CONFORMANCE_MODULE = "../conformance/index.js";
const suites = async (): Promise<Record<string, unknown>> =>
  (await import(/* @vite-ignore */ CONFORMANCE_MODULE).catch(() => ({}))) as Record<string, unknown>;

// RED as of 186f9fd9: the conformance module does not exist; every adapter is certified by its own file only.
describe.skip("[R53 WAVE-F COUNTEREXAMPLE #29] the protocol conformance suites exist", () => {
  it("exports one suite per protocol this program defines", async () => {
    const mod = await suites();
    for (const name of [
      "describeManagedDispatch",
      "describeRuntimeWorkControl",
      "describeUnknownPropagation",
      "describePublicationOperation",
      "describeCancellationVerification",
    ])
      expect(typeof mod[name], `${name} is not exported — this protocol has no shared certification`).toBe("function");
  });
});
