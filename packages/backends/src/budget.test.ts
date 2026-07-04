import type { CaseResult } from "@assay/core";
import { PaymentRequiredError } from "@assay/core";
import { describe, expect, it } from "vitest";
import { billingTenant, inMemoryBudget, sumCost } from "./budget.js";

describe("sumCost", () => {
  it("트레이스의 llm_call cost(usd/토큰)를 합산한다", () => {
    const c = sumCost([
      { t: 0, kind: "tool_call", id: "1", name: "x", args: {} },
      { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 10, outputTokens: 5, usd: 0.03 } },
      { t: 2, kind: "llm_call", model: "m", cost: { inputTokens: 20, outputTokens: 0, usd: 0.02 } },
    ]);
    expect(c.usd).toBeCloseTo(0.05);
    expect(c.tokens).toBe(35);
  });
});

describe("inMemoryBudget", () => {
  it("runs 상한: admit 가 즉시 예약하므로 버스트도 상한을 못 넘는다", () => {
    const b = inMemoryBudget({ limitFor: () => ({ runs: 2 }) });
    b.admit("t");
    b.admit("t");
    expect(() => b.admit("t")).toThrow(PaymentRequiredError);
    expect(b.usage("t").runs).toBe(2);
  });

  it("usd 상한: 이미 commit 된 비용이 상한 이상이면 거절", () => {
    const b = inMemoryBudget({ limitFor: () => ({ usd: 0.1 }) });
    b.admit("t");
    b.settle("t", { usd: 0.1, tokens: 100 });
    expect(() => b.admit("t")).toThrow(PaymentRequiredError); // 0.1 >= 0.1
    expect(b.usage("t").usd).toBeCloseTo(0.1);
  });

  it("테넌트별로 독립적이다 (A 소진이 B 에 영향 없음)", () => {
    const b = inMemoryBudget({ limitFor: () => ({ runs: 1 }) });
    b.admit("A");
    expect(() => b.admit("A")).toThrow();
    expect(() => b.admit("B")).not.toThrow(); // B 는 별개
  });

  it("무제한이어도 실행 수는 집계한다", () => {
    const b = inMemoryBudget({ limitFor: () => undefined });
    b.admit("t");
    b.admit("t");
    expect(b.usage("t").runs).toBe(2);
  });
});

describe("billingTenant — 비용을 누구 예산에 다나(provenance 기반)", () => {
  const result = (provenance?: CaseResult["provenance"]): CaseResult => ({
    caseId: "c",
    harness: "h@0",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
    ...(provenance ? { provenance } : {}),
  });

  it("관리형(provenance 없음): 잡의 원래 테넌트가 결제", () => {
    expect(billingTenant(result(), "acme")).toBe("acme");
  });

  it("관리형(ranOn≠self-hosted): 원래 테넌트가 결제", () => {
    expect(billingTenant(result({ ranOn: "nomad" }), "acme")).toBe("acme");
  });

  it("워크스페이스-공유 러너(by=ws:<ws>): 그 워크스페이스가 결제(팀 자원)", () => {
    expect(billingTenant(result({ ranOn: "self-hosted", runner: "r1", by: "ws:acme" }), "acme")).toBe("acme");
    // 다른 워크스페이스로 by 가 왔다면 by 를 신뢰(귀속 = 러너 소유 워크스페이스)
    expect(billingTenant(result({ ranOn: "self-hosted", by: "ws:beta" }), "acme")).toBe("beta");
  });

  it("개인 셀프호스티드 러너(by=subject): own-pays → undefined(미차감)", () => {
    expect(billingTenant(result({ ranOn: "self-hosted", runner: "r1", by: "u-alice" }), "acme")).toBeUndefined();
    // by 없음(구형)도 개인으로 간주 — own-pays
    expect(billingTenant(result({ ranOn: "self-hosted" }), "acme")).toBeUndefined();
  });
});
