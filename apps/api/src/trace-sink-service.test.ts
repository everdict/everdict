import type { CaseResult } from "@assay/core";
import { InMemoryWorkspaceSettingsStore } from "@assay/db";
import type { TraceSinkConfig } from "@assay/trace";
import { describe, expect, it } from "vitest";
import { TraceSinkService } from "./trace-sink-service.js";

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [{ t: 0, kind: "llm_call", model: "m" }],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "x" },
  scores: [
    { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true },
    { graderId: "judge", metric: "judge:q", value: 0.7, detail: "근거" },
  ],
};
const CTX = { scorecardId: "sc-1", dataset: "d@1", harness: "h@1" };

// 설정된 스토어 + 캡처하는 fake buildSink 로 서비스 구성.
async function exportHarness(over: {
  sinkResult?: { url?: string; cases: Array<{ caseId: string; externalId?: string; error?: string }> };
  throwOnExport?: boolean;
  secrets?: Record<string, string>;
  authSecretName?: string;
}) {
  const store = new InMemoryWorkspaceSettingsStore();
  await store.set("acme", {
    traceSink: {
      kind: "mlflow",
      endpoint: "http://mlflow:5000",
      project: "7",
      ...(over.authSecretName ? { authSecretName: over.authSecretName } : {}),
    },
  });
  const captured: { cfg?: TraceSinkConfig; cases?: Array<{ caseId: string; externalId?: string }> } = {};
  const svc = new TraceSinkService(store, {
    secretsFor: async () => over.secrets ?? {},
    buildSink: (cfg) => {
      captured.cfg = cfg;
      return {
        async export(_ctx, cases) {
          if (over.throwOnExport) throw new Error("업스트림 연결 실패");
          captured.cases = cases.map((c) => ({
            caseId: c.caseId,
            ...(c.externalId ? { externalId: c.externalId } : {}),
          }));
          return over.sinkResult ?? { cases: cases.map((c) => ({ caseId: c.caseId, externalId: `ext-${c.caseId}` })) };
        },
      };
    },
    now: () => "2026-07-06T00:00:00.000Z",
  });
  return { svc, captured };
}

describe("TraceSinkService.exportScorecard", () => {
  it("싱크 설정+시크릿을 resolve 해 어댑터로 내보내고 succeeded outcome 을 만든다", async () => {
    const { svc, captured } = await exportHarness({
      authSecretName: "MLFLOW_AUTH",
      secrets: { MLFLOW_AUTH: "Basic x" },
    });
    const out = await svc.exportScorecard("acme", CTX, [RESULT]);
    // 설정 → 어댑터 config(auth 는 시크릿 '값'), 점수는 metric→name/detail→comment 로 매핑.
    expect(captured.cfg).toMatchObject({
      kind: "mlflow",
      endpoint: "http://mlflow:5000",
      auth: "Basic x",
      project: "7",
    });
    expect(out?.status).toBe("succeeded");
    expect(out?.cases?.[0]?.externalId).toBe("ext-c1");
    expect(out?.exportedAt).toBe("2026-07-06T00:00:00.000Z");
  });

  it("싱크 미설정이면 no-op(undefined) — 스코어카드는 아무 것도 기록하지 않는다", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore(), {
      buildSink: () => ({ export: async () => ({ cases: [] }) }),
    });
    expect(await svc.exportScorecard("acme", CTX, [RESULT])).toBeUndefined();
  });

  it("authSecretName 의 시크릿 값이 없으면 failed outcome(정직한 실패 — 조용한 무인증 호출 금지)", async () => {
    const { svc } = await exportHarness({ authSecretName: "MISSING", secrets: {} });
    const out = await svc.exportScorecard("acme", CTX, [RESULT]);
    expect(out?.status).toBe("failed");
    expect(out?.message).toContain("MISSING");
  });

  it("attach 는 소스와 싱크 플랫폼이 같을 때만 externalId 를 넘기고, 다르면 create 모드로 폴백한다", async () => {
    const { svc, captured } = await exportHarness({});
    await svc.exportScorecard("acme", CTX, [RESULT], {
      sourceKind: "mlflow",
      externalIdByCase: { c1: "tr-orig" },
    });
    expect(captured.cases?.[0]?.externalId).toBe("tr-orig"); // mlflow=mlflow → attach

    const { svc: svc2, captured: cap2 } = await exportHarness({});
    await svc2.exportScorecard("acme", CTX, [RESULT], {
      sourceKind: "otel",
      externalIdByCase: { c1: "tr-orig" },
    });
    expect(cap2.cases?.[0]?.externalId).toBeUndefined(); // otel≠mlflow → create
  });

  it("케이스 일부 실패는 partial, 어댑터 throw 는 failed 로 — 절대 throw 하지 않는다(격리 계약)", async () => {
    const { svc } = await exportHarness({
      sinkResult: {
        cases: [
          { caseId: "c1", externalId: "e1" },
          { caseId: "c2", error: "500" },
        ],
      },
    });
    const partial = await svc.exportScorecard("acme", CTX, [RESULT, { ...RESULT, caseId: "c2" }]);
    expect(partial?.status).toBe("partial");
    expect(partial?.message).toContain("1/2");

    const { svc: svc2 } = await exportHarness({ throwOnExport: true });
    const failed = await svc2.exportScorecard("acme", CTX, [RESULT]);
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toContain("업스트림 연결 실패");
  });
});

describe("TraceSinkService", () => {
  it("관리자가 싱크를 등록하면 조회에 노출되고, 선언형 전체 교체로 갱신된다", async () => {
    // Given: 설정 스토어와 서비스.
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    // When: MLflow 싱크 등록(시크릿은 이름 참조만).
    const set = await svc.set("acme", {
      kind: "mlflow",
      endpoint: "http://mlflow.corp.io:5000",
      authSecretName: "MLFLOW_AUTH",
      project: "7",
    });
    // Then: 조회에 그대로 노출된다(비밀 값 없음).
    expect(set).toEqual({
      kind: "mlflow",
      endpoint: "http://mlflow.corp.io:5000",
      authSecretName: "MLFLOW_AUTH",
      project: "7",
    });
    // When: 다른 플랫폼으로 전체 교체(이전 project 는 이월되지 않는다 — 선언형).
    const replaced = await svc.set("acme", { kind: "langfuse", endpoint: "https://langfuse.corp.io" });
    expect(replaced).toEqual({ kind: "langfuse", endpoint: "https://langfuse.corp.io" });
  });

  it("해제(clear)하면 조회에서 사라지고, 워크스페이스 간에 격리된다", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    await svc.set("acme", { kind: "phoenix", endpoint: "http://phoenix.corp.io:6006" });
    await svc.set("globex", { kind: "langsmith", endpoint: "https://api.smith.langchain.com" });
    // When: acme 만 해제.
    await svc.clear("acme");
    // Then: acme 는 미설정, globex 는 유지(테넌트 격리).
    expect(await svc.get("acme")).toBeUndefined();
    expect((await svc.get("globex"))?.kind).toBe("langsmith");
  });
});
