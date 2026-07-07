import { BadRequestError, type CaseResult } from "@everdict/core";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import type { TraceSinkConfig } from "@everdict/trace";
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

describe("TraceSinkService — 복수 싱크 CRUD + 하니스별 선택", () => {
  it("이름 기준 upsert 로 여러 싱크를 등록/갱신하고 목록으로 조회한다", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000", project: "7" });
    await svc.upsert("acme", { name: "lf", kind: "langfuse", endpoint: "https://lf.corp.io" });
    // 같은 이름 upsert = 교체(선언형).
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow2:5000" });
    const { sinks } = await svc.list("acme");
    expect(sinks.map((s) => s.name).sort()).toEqual(["lf", "mlf"]);
    expect(sinks.find((s) => s.name === "mlf")?.endpoint).toBe("http://mlflow2:5000");
    expect(sinks.find((s) => s.name === "mlf")?.project).toBeUndefined(); // 전체 교체 — 이전 project 이월 안 함
  });

  it("하니스별 선택: 등록된 싱크만 가리킬 수 있고(없으면 400), null 은 선택 해제다", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await expect(svc.assign("acme", "h1", "없는싱크")).rejects.toBeInstanceOf(BadRequestError);
    expect(await svc.assign("acme", "h1", "mlf")).toEqual({ h1: "mlf" });
    expect(await svc.assign("acme", "h2", "mlf")).toEqual({ h1: "mlf", h2: "mlf" });
    expect(await svc.assign("acme", "h1", null)).toEqual({ h2: "mlf" }); // 해제
  });

  it("싱크 해제(remove)는 그 싱크를 가리키던 하니스 선택도 함께 정리한다(dangling 방지) + 워크스페이스 격리", async () => {
    const svc = new TraceSinkService(new InMemoryWorkspaceSettingsStore());
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await svc.upsert("acme", { name: "lf", kind: "langfuse", endpoint: "https://lf" });
    await svc.assign("acme", "h1", "mlf");
    await svc.assign("acme", "h2", "lf");
    await svc.upsert("globex", { name: "mlf", kind: "mlflow", endpoint: "http://other:5000" });
    await svc.remove("acme", "mlf");
    const acme = await svc.list("acme");
    expect(acme.sinks.map((s) => s.name)).toEqual(["lf"]);
    expect(acme.assignments).toEqual({ h2: "lf" }); // mlf 를 가리키던 h1 만 정리
    expect((await svc.list("globex")).sinks).toHaveLength(1); // 테넌트 격리
  });
});

// 하니스 h 가 mlf 싱크를 선택한 상태의 서비스 + 캡처 fake buildSink.
async function exportHarness(over: {
  sinkResult?: { url?: string; cases: Array<{ caseId: string; externalId?: string; error?: string }> };
  throwOnExport?: boolean;
  secrets?: Record<string, string>;
  authSecretName?: string;
  assignTo?: string | null; // 기본 "h"(CTX.harness 의 id). null = 선택 없음
}) {
  const store = new InMemoryWorkspaceSettingsStore();
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
          // 서비스는 케이스별로 호출한다(스트리밍) — 고정 sinkResult 는 이 호출의 케이스 몫만 잘라 돌려준다.
          if (over.sinkResult)
            return {
              ...(over.sinkResult.url ? { url: over.sinkResult.url } : {}),
              cases: over.sinkResult.cases.filter((rc) => cases.some((c) => c.caseId === rc.caseId)),
            };
          return { cases: cases.map((c) => ({ caseId: c.caseId, externalId: `ext-${c.caseId}` })) };
        },
      };
    },
    now: () => "2026-07-06T00:00:00.000Z",
  });
  await svc.upsert("acme", {
    name: "mlf",
    kind: "mlflow",
    endpoint: "http://mlflow:5000",
    project: "7",
    ...(over.authSecretName ? { authSecretName: over.authSecretName } : {}),
  });
  if (over.assignTo !== null) await svc.assign("acme", over.assignTo ?? "h", "mlf");
  return { svc, captured };
}

describe("TraceSinkService.exportScorecard — 하니스별 선택 해석", () => {
  it("ctx.harness 의 id 로 선택된 싱크를 해석해 내보내고, outcome 에 싱크 이름을 남긴다", async () => {
    const { svc, captured } = await exportHarness({
      authSecretName: "MLFLOW_AUTH",
      secrets: { MLFLOW_AUTH: "Basic x" },
    });
    const out = await svc.exportScorecard("acme", CTX, [RESULT]);
    expect(captured.cfg).toMatchObject({
      kind: "mlflow",
      endpoint: "http://mlflow:5000",
      auth: "Basic x",
      project: "7",
    });
    expect(out?.status).toBe("succeeded");
    expect(out?.name).toBe("mlf"); // 어느 싱크였는지 기록
    expect(out?.cases?.[0]?.externalId).toBe("ext-c1");
  });

  it("하니스가 싱크를 선택하지 않았으면 no-op(undefined) — 적재는 옵트인", async () => {
    const { svc } = await exportHarness({ assignTo: null });
    expect(await svc.exportScorecard("acme", CTX, [RESULT])).toBeUndefined();
  });

  it("다른 하니스의 선택은 이 하니스에 적용되지 않는다(하니스별 분리)", async () => {
    const { svc } = await exportHarness({ assignTo: "other-harness" });
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
    await svc.exportScorecard("acme", CTX, [RESULT], { sourceKind: "mlflow", externalIdByCase: { c1: "tr-orig" } });
    expect(captured.cases?.[0]?.externalId).toBe("tr-orig"); // mlflow=mlflow → attach

    const { svc: svc2, captured: cap2 } = await exportHarness({});
    await svc2.exportScorecard("acme", CTX, [RESULT], { sourceKind: "otel", externalIdByCase: { c1: "tr-orig" } });
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

describe("TraceSinkService.exportStream — 케이스 스트리밍(D5)", () => {
  it("push 는 settle 을 기다리지 않고 케이스별로 즉시 발사되고, settle 이 기존 outcome 형태로 합산한다", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    const calls: string[][] = []; // 호출 단위의 케이스 구성 — 케이스별 개별 호출이어야 한다
    const svc = new TraceSinkService(store, {
      buildSink: () => ({
        async export(_ctx, cases) {
          calls.push(cases.map((c) => c.caseId));
          return {
            url: "http://mlflow/#/experiments/7",
            cases: cases.map((c) => ({ caseId: c.caseId, externalId: `ext-${c.caseId}` })),
          };
        },
      }),
      now: () => "2026-07-07T00:00:00.000Z",
    });
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await svc.assign("acme", "h", "mlf");

    const stream = await svc.exportStream("acme", CTX);
    if (!stream) throw new Error("싱크가 선택됐으니 스트림이 있어야 한다");
    stream.push(RESULT);
    await new Promise((r) => setTimeout(r, 0)); // 태스크 발사 tick
    expect(calls).toEqual([["c1"]]); // settle 전에 이미 나갔다 — 스트리밍의 핵심
    stream.push({ ...RESULT, caseId: "c2" });

    const out = await stream.settle();

    expect(calls).toEqual([["c1"], ["c2"]]); // 케이스별 개별 호출
    expect(out.status).toBe("succeeded");
    expect(out.url).toBe("http://mlflow/#/experiments/7");
    expect(out.cases?.map((c) => c.caseId)).toEqual(["c1", "c2"]);
  });

  it("케이스별 실패는 격리 — 한 케이스의 업스트림 에러가 다른 케이스를 막지 않고 partial 로 합산된다", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    const svc = new TraceSinkService(store, {
      buildSink: () => ({
        async export(_ctx, cases) {
          const id = cases[0]?.caseId ?? "?";
          if (id === "c1") throw new Error("c1 만 업스트림 500");
          return { cases: cases.map((c) => ({ caseId: c.caseId, externalId: `ext-${c.caseId}` })) };
        },
      }),
      now: () => "2026-07-07T00:00:00.000Z",
    });
    await svc.upsert("acme", { name: "mlf", kind: "mlflow", endpoint: "http://mlflow:5000" });
    await svc.assign("acme", "h", "mlf");

    const stream = await svc.exportStream("acme", CTX);
    if (!stream) throw new Error("스트림 기대");
    stream.push(RESULT); // c1 — 실패
    stream.push({ ...RESULT, caseId: "c2" }); // c2 — 성공
    const out = await stream.settle();

    expect(out.status).toBe("partial");
    expect(out.message).toContain("1/2");
    expect(out.cases?.find((c) => c.caseId === "c1")?.error).toContain("업스트림 500");
    expect(out.cases?.find((c) => c.caseId === "c2")?.externalId).toBe("ext-c2");
  });
});
