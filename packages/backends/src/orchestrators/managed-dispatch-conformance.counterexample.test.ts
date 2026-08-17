import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeManagedDispatch,
  describeRuntimeWorkControl,
  describeUnknownPropagation,
} from "../conformance/index.js";

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

// Statically imported now that the module exists — the counterexample was written against its absence, and a
// dynamic specifier would keep asserting that absence is survivable.
const placementSuites: Record<string, unknown> = {
  describeManagedDispatch,
  describeRuntimeWorkControl,
  describeUnknownPropagation,
};

// RED as of 186f9fd9: the conformance module does not exist; every adapter is certified by its own file only.
describe("[R53 WAVE-F COUNTEREXAMPLE #29 — CLOSED] the protocol conformance suites exist", () => {
  it("exports one suite per protocol this program defines", () => {
    for (const name of ["describeManagedDispatch", "describeRuntimeWorkControl", "describeUnknownPropagation"])
      expect(typeof placementSuites[name], `${name} is not exported — this protocol has no shared certification`).toBe(
        "function",
      );

    // …and the control-plane half, asserted at its source because this package cannot import it (backends
    // DEPENDS on application-control, so the edge only runs the other way).
    const controlPlane = readFileSync(
      fileURLToPath(new URL("../../../application-control/src/conformance/index.ts", import.meta.url)),
      "utf8",
    );
    for (const name of ["describePublicationOperation", "describeCancellationVerification"])
      expect(controlPlane.includes(`export function ${name}`), `${name} has no shared certification`).toBe(true);
  });

  it("the managed backends actually RUN the placement suites", () => {
    // A suite nobody calls certifies nothing. This asserts the call sites exist, which is the half a
    // "does it export the function" check cannot see.
    const runner = readFileSync(fileURLToPath(new URL("./managed-conformance.test.ts", import.meta.url)), "utf8");
    for (const call of ['describeManagedDispatch("K8sBackend"', 'describeManagedDispatch("NomadBackend"'])
      expect(runner.includes(call), `${call} — a managed backend is not running the dispatch suite`).toBe(true);
  });
});
