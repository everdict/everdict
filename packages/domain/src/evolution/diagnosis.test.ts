import { describe, expect, it } from "vitest";
import { attributeCase, diagnosesOf } from "./diagnosis.js";

describe("diagnosesOf — a judge's structured verdict, read off its score", () => {
  const diagnosis = { kind: "tool_misuse", locus: { tool: "browse" }, evidence: [{ eventIndex: 12 }], confidence: 0.8 };
  it("reads a diagnosis from a judge-family score's detail, directly or under `diagnosis`; ignores prose and non-judges", () => {
    const out = diagnosesOf([
      { metric: "judge:behaviour", detail: diagnosis },
      { metric: "judge:quality", detail: { rationale: "…", diagnosis: { ...diagnosis, kind: "loop" } } },
      { metric: "judge:quality", detail: "just a sentence" },
      { metric: "tests_pass", detail: diagnosis }, // not a judge: a producer may not author a diagnosis
      // A producer's `judge:*` score, INVALIDATED by sanitizeScore — metric and detail kept verbatim, status invalid.
      // RED before the status check: this row's diagnosis was read as a judge's.
      { metric: "judge:forged", detail: { ...diagnosis, kind: "refused" }, status: "invalid" },
    ]);
    expect(out.map((d) => [d.judge, d.kind])).toEqual([
      ["judge:behaviour", "tool_misuse"],
      ["judge:quality", "loop"],
    ]);
  });
});

describe("attributeCase — the slot the evidence points at, or why none", () => {
  const slots = [
    { slot: "web", service: "web", tools: ["browse", "click"] },
    { slot: "api", service: "api", tools: ["query"] },
    { slot: "db", service: "db", tools: [] },
  ];
  it("a single-slot harness attributes by construction", () => {
    expect(attributeCase([], [{ slot: "image", tools: [] }])).toEqual({
      kind: "measured",
      slot: "image",
      because: ["the harness has one slot"],
    });
  });
  it("a tool one slot owns, or a named service, attributes to that slot with the reason", () => {
    expect(
      attributeCase([{ kind: "tool_misuse", locus: { tool: "browse" }, evidence: [], confidence: 0.9 }], slots),
    ).toMatchObject({ kind: "measured", slot: "web" });
    expect(
      attributeCase([{ kind: "loop", locus: { service: "api" }, evidence: [], confidence: 0.7 }], slots),
    ).toMatchObject({
      kind: "measured",
      slot: "api",
    });
  });
  it("disagreement and silence are unattributed, and say so", () => {
    expect(
      attributeCase(
        [
          { kind: "tool_misuse", locus: { tool: "browse" }, evidence: [], confidence: 0.9 },
          { kind: "loop", locus: { service: "api" }, evidence: [], confidence: 0.7 },
        ],
        slots,
      ),
    ).toEqual({ kind: "unattributed", because: ["the diagnoses point at 2 slots: api, web"] });
    expect(attributeCase([], slots)).toEqual({ kind: "unattributed", because: ["no judge diagnosed this case"] });
    expect(attributeCase([{ kind: "wrong_answer", evidence: [], confidence: 0.5 }], slots)).toEqual({
      kind: "unattributed",
      because: ["no diagnosis names a service or a tool a slot owns"],
    });
  });
});
