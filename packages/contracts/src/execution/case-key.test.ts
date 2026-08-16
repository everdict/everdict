import { describe, expect, it } from "vitest";
import { caseKeyAddress, caseKeyOf, decodeCaseKey, encodeCaseKey } from "./case-key.js";

describe("CaseKey — the (case, trial) identity", () => {
  it("keeps the spelling every stored digest was computed under", () => {
    // Given a case id with no delimiter in it — which is every realistic dataset case id, including the
    // slash- and colon-bearing ones (`swe-bench/astropy__astropy-12907`)
    // Then the encoding is the literal the score plane and the receipt ledger have always used, so no
    // already-persisted digest moves under this promotion.
    expect(encodeCaseKey(caseKeyOf("c1"))).toBe("c1#0");
    expect(encodeCaseKey(caseKeyOf("c1", 0))).toBe("c1#0");
    expect(encodeCaseKey(caseKeyOf("c1", 2))).toBe("c1#2");
    expect(encodeCaseKey(caseKeyOf("swe-bench/astropy__astropy-12907", 1))).toBe("swe-bench/astropy__astropy-12907#1");
  });

  it("cannot collide two different executions onto one key", () => {
    // Given two genuinely different executions that the unescaped spelling collapsed onto `a#1`
    const withHashInId = caseKeyOf("a#1", 0);
    const trialOne = caseKeyOf("a", 1);

    // Then they are distinct keys — the collision mattered because these maps are how a receipt is matched
    // to the case it vouches for.
    expect(encodeCaseKey(withHashInId)).not.toBe(encodeCaseKey(trialOne));
    expect(decodeCaseKey(encodeCaseKey(withHashInId))).toEqual(withHashInId);
    expect(decodeCaseKey(encodeCaseKey(trialOne))).toEqual(trialOne);
  });

  it("round-trips ids containing the delimiter and the escape character", () => {
    for (const caseId of ["a#1", "100%", "%23", "a#b%c", "plain"]) {
      expect(decodeCaseKey(encodeCaseKey(caseKeyOf(caseId, 3)))).toEqual({ caseId, trial: 3 });
    }
  });

  it("addresses a case with no trial axis exactly as it is already stored", () => {
    // Given a single-run result (no trial axis) — Then its durable address is the bare case id, which is
    // what every artifact key and materialized trajectory runId written before trials points at.
    expect(caseKeyAddress(caseKeyOf("c1"))).toBe("c1");
    // …and a trialled one carries the trial, because k results sharing one address is k−1 overwritten.
    expect(caseKeyAddress(caseKeyOf("c1", 0))).toBe("c1#0");
    expect(caseKeyAddress(caseKeyOf("c1", 1))).toBe("c1#1");
  });

  it("distinguishes 'no trial axis' from 'trial 0' in the value, and collapses them only for keying", () => {
    // The distinction is what keeps old addresses readable; the collapse is what keeps old digests stable.
    expect(caseKeyOf("c1")).toEqual({ caseId: "c1" });
    expect(caseKeyOf("c1", 0)).toEqual({ caseId: "c1", trial: 0 });
    expect(encodeCaseKey(caseKeyOf("c1"))).toBe(encodeCaseKey(caseKeyOf("c1", 0)));
    expect(caseKeyAddress(caseKeyOf("c1"))).not.toBe(caseKeyAddress(caseKeyOf("c1", 0)));
  });
});
