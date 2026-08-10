import { describe, expect, it } from "vitest";
import type { ResolvedSeriesContract } from "../product/readiness.js";
import { seriesContractDigest, seriesContractStampHolds } from "../product/readiness.js";
import { pinnedDocumentMismatch, verifySealedSelection } from "../scorecard/sealed-execution.js";
import { contentDigest } from "./content-digest.js";

// Trust suite (docs/trust-certification.md) — TRUST-117.
//
// A MIGRATION MUST NOT LOOK LIKE AN ATTACK.
//
// Stamps written before this codebase moved to sha256 are FNV-1a (bare 16 hex), and the policy for them is
// already stated and implemented: verify legacy stamps under their OWN algorithm (`digestsMatch`), because
// history has to keep verifying. One reader followed it. Every seal comparison in the trust kernel — dataset
// cases, grading, harness document, every nested pin — used `contentDigest(doc) !== stamped` instead, and a
// sha256 recomputation disagrees with an FNV stamp on every character.
//
// The result is not fail-open, which is why it survived: it is a batch sealed in that era refusing to resume,
// re-score or re-verify against ITS OWN UNCHANGED DOCUMENTS, and reporting a registry shadow as the reason.
// The one thing worse than a guard that misses is a guard that accuses.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

// The legacy algorithm, reproduced from the era's own rule: FNV-1a 64-bit over the same canonical text.
function legacyStamp(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
        .join(",")}}`;
    return JSON.stringify(v);
  };
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonical(value))) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

describeTrust("TRUST-117 — a stamp from the previous digest era still verifies against its own document", () => {
  const caseDoc = { id: "c1", env: { kind: "prompt" }, task: "do", graders: undefined, timeoutSec: 60, tags: [] };

  it("the legacy fixture is genuinely legacy — bare hex, and NOT what sha256 produces", () => {
    // A fixture that quietly produced a sha256 stamp would certify nothing, which is how this whole class of
    // defect stays invisible.
    const stamp = legacyStamp({ ...caseDoc, graders: undefined });
    expect(stamp).toMatch(/^[0-9a-f]{16}$/);
    expect(stamp).not.toBe(contentDigest({ ...caseDoc, graders: undefined }));
  });

  it("a sealed dataset case stamped under the old algorithm reads as HELD, not as a shadow", () => {
    const manifest = {
      identityVersion: 1,
      dataset: { id: "d", version: "1.0.0", digest: "sha256:x" },
      harness: { id: "h", version: "1" },
      cases: { c1: legacyStamp({ ...caseDoc, graders: undefined }) },
    } as never;
    expect(verifySealedSelection(manifest, { cases: [caseDoc as never] })).toEqual([]);
  });

  it("…and a nested document pin does too, while a genuinely changed document still refuses", () => {
    const model = { id: "model-x", version: "1.0.0", provider: "anthropic", model: "claude-opus-4-8" };
    expect(pinnedDocumentMismatch(legacyStamp(model), model, { kind: "model", ref: "model-x@1" })).toBeUndefined();
    expect(
      pinnedDocumentMismatch(legacyStamp(model), { ...model, model: "cheaper" }, { kind: "model", ref: "model-x@1" }),
    ).toBeDefined();
  });

  it("a series contract stamped in the old era is still CURRENT — freshness must not demand a pointless re-run", () => {
    const contract: ResolvedSeriesContract = {
      dataset: { id: "d", version: "1.0.0", digest: "sha256:ds" },
      harness: { id: "h", version: "1.0.0", specDigest: "sha256:hs" },
      judges: [],
    };
    const stamped = legacyStamp(
      JSON.parse(JSON.stringify({ dataset: contract.dataset, harness: contract.harness, judges: [] })),
    );
    expect(stamped).not.toBe(seriesContractDigest(contract));
    expect(seriesContractStampHolds(stamped, contract)).toBe(true);
    // …and a contract that really moved is still stale under either algorithm.
    expect(seriesContractStampHolds(stamped, { ...contract, judges: [{ id: "quality", version: "1.0.0" }] })).toBe(
      false,
    );
  });
});
