import type { CaseResult, Scorecard, TraceEvent } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { scorecardModels } from "./models.js";

// llm_call 이벤트만 model 축에 기여한다. 케이스 하나에 여러 호출(모델 혼용) 가능.
const llm = (model: string): TraceEvent => ({ t: 0, kind: "llm_call", model });
const result = (caseId: string, models: string[]): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: models.map(llm),
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
});
const sc = (results: CaseResult[]): Scorecard => ({ suiteId: "d", harness: "h@1", results });

describe("scorecardModels", () => {
  it("트레이스 관측 모델을 distinct·정렬로 모으고 최빈값을 primary 로", () => {
    const m = scorecardModels(sc([result("c1", ["claude-opus-4-8", "claude-opus-4-8"]), result("c2", ["gpt-4"])]));
    expect(m.observed).toEqual(["claude-opus-4-8", "gpt-4"]); // 정렬·중복제거
    expect(m.primary).toBe("claude-opus-4-8"); // 2회 관측 > 1회
    expect(m.declared).toBeUndefined();
  });

  it("동률이면 사전순 첫값이 primary(결정적)", () => {
    const m = scorecardModels(sc([result("c1", ["b-model"]), result("c2", ["a-model"])]));
    expect(m.primary).toBe("a-model");
  });

  it("관측이 있으면 declared 보다 관측이 우선(primary=관측) — 선언≠실제 드리프트 보존", () => {
    const m = scorecardModels(sc([result("c1", ["gpt-4o"])]), "gpt-4");
    expect(m.observed).toEqual(["gpt-4o"]);
    expect(m.declared).toBe("gpt-4");
    expect(m.primary).toBe("gpt-4o");
  });

  it("관측이 없으면 declared 를 primary 로 폴백(예: 트레이스에 model 없는 하니스)", () => {
    const m = scorecardModels(sc([result("c1", [])]), "claude-sonnet-4-6");
    expect(m.observed).toEqual([]);
    expect(m.primary).toBe("claude-sonnet-4-6");
  });

  it("관측도 선언도 없으면 primary 미설정(unknown)", () => {
    const m = scorecardModels(sc([result("c1", [])]));
    expect(m.observed).toEqual([]);
    expect(m.primary).toBeUndefined();
    expect(m.declared).toBeUndefined();
  });

  it("빈 model 문자열은 무시한다(합성 usage 프록시가 빈 값을 낼 수 있음)", () => {
    const m = scorecardModels(sc([result("c1", ["", "gpt-4"])]), "");
    expect(m.observed).toEqual(["gpt-4"]);
    expect(m.primary).toBe("gpt-4");
    expect(m.declared).toBeUndefined();
  });
});
