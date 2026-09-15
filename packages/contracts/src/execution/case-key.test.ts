import { describe, expect, it } from "vitest";
import { caseKeyAddress, caseKeyOf, encodeCaseKey } from "./case-key.js";

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
  });

  it("spells every id carrying the delimiter or the escape character as a key of its own", () => {
    // Given ids that differ only by what the escape rewrites (`#` vs its escape `%23`, `%` vs `%25`), each at
    // two trials
    const keys = ["a#1", "a", "#", "%23", "100%", "100%25", "a#b%c", "a%23b%25c", "plain"].flatMap((caseId) => [
      caseKeyOf(caseId, 0),
      caseKeyOf(caseId, 3),
    ]);
    expect(keys).toHaveLength(18);
    // Then no two of them share an encoding — the escape is injective
    expect(new Set(keys.map(encodeCaseKey)).size).toBe(keys.length);
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
