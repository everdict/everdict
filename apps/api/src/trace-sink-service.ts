import { BadRequestError, type CaseResult } from "@assay/core";
import type { ScorecardExport, WorkspaceSettings, WorkspaceSettingsStore } from "@assay/db";
import type { TraceSink, TraceSinkCase, TraceSinkConfig } from "@assay/trace";
import { createLimiter } from "./concurrency.js";

// 워크스페이스 트레이스 싱크 통합 — judge 된 스코어카드 상세 결과를 팀 관측 플랫폼(MLflow/Langfuse/LangSmith/Phoenix)에
// 적재하는 아웃바운드 설정. 싱크는 '복수'를 이름으로 등록하고(팀마다 플랫폼이 여러 개), 어느 싱크로 보낼지는
// '하니스별로' 선택한다(traceSinkByHarness: harness id → sink name; 선택 없는 하니스는 적재 안 함 — 옵트인).
// 비밀 없음: authSecretName 은 값이 아닌 SecretStore 이름 참조라 반환 안전. HTTP 라우트와 MCP 도구가 이 코어를 공유.
// 설계: docs/architecture/trace-sink.md

// 싱크 1건 현황(비밀 없음 — 전부 이름 참조/URL).
export interface TraceSinkConfigView {
  name: string;
  kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  authSecretName?: string;
  project?: string;
  webUrl?: string;
}

type TraceSinkEntry = NonNullable<WorkspaceSettings["traceSinks"]>[number];

export interface TraceSinkServiceDeps {
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // authSecretName → 값 resolve(워크스페이스 SecretStore)
  buildSink?: (cfg: TraceSinkConfig) => TraceSink; // 설정 → 어댑터(@assay/trace buildTraceSink). 미주입이면 적재 비활성
  exportConcurrency?: number; // 케이스 축 export 동시 실행 상한(기본 2) — 싱크 rate-limit 보호
  now?: () => string;
}

// 케이스 스트리밍 export 핸들 — 배치가 케이스 완성(judge 후) 즉시 push, settle 이 전 태스크 합류 후
// 기존 exportScorecard 와 동일한 ScorecardExport 형태로 합산(레코드 스키마·웹 표시 무변경).
// push 태스크는 절대 throw 하지 않는다 — export 실패는 outcome 에만 남는다(스코어카드와 격리).
export interface CaseExportStream {
  push(result: CaseResult): void;
  settle(): Promise<ScorecardExport>;
}

type SinkCaseOutcome = NonNullable<ScorecardExport["cases"]>[number];

const toView = (s: TraceSinkEntry): TraceSinkConfigView => ({
  name: s.name,
  kind: s.kind,
  endpoint: s.endpoint,
  ...(s.authSecretName ? { authSecretName: s.authSecretName } : {}),
  ...(s.project ? { project: s.project } : {}),
  ...(s.webUrl ? { webUrl: s.webUrl } : {}),
});

export class TraceSinkService {
  constructor(
    private readonly settings: WorkspaceSettingsStore,
    private readonly deps: TraceSinkServiceDeps = {},
  ) {}

  // 등록된 싱크 목록 + 하니스별 선택 현황.
  async list(workspace: string): Promise<{ sinks: TraceSinkConfigView[]; assignments: Record<string, string> }> {
    const s = await this.settings.get(workspace);
    return {
      sinks: (s?.traceSinks ?? []).map(toView),
      assignments: s?.traceSinkByHarness ?? {},
    };
  }

  // 등록/갱신(관리자, 이름 기준 upsert — 선언형 전체 교체). 인증 토큰(값)은 SecretStore 에 먼저 넣고 이름만 지정.
  async upsert(
    workspace: string,
    input: {
      name: string;
      kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
      endpoint: string;
      authSecretName?: string;
      project?: string;
      webUrl?: string;
    },
  ): Promise<TraceSinkConfigView> {
    const entry: TraceSinkEntry = {
      name: input.name,
      kind: input.kind,
      endpoint: input.endpoint,
      ...(input.authSecretName ? { authSecretName: input.authSecretName } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.webUrl ? { webUrl: input.webUrl } : {}),
    };
    const existing = (await this.settings.get(workspace))?.traceSinks ?? [];
    const next = [...existing.filter((s) => s.name !== input.name), entry];
    await this.settings.set(workspace, { traceSinks: next });
    return toView(entry);
  }

  // 해제(관리자). 그 싱크를 가리키던 하니스 선택도 함께 정리한다(dangling 참조 방지).
  async remove(workspace: string, name: string): Promise<void> {
    const s = await this.settings.get(workspace);
    const next = (s?.traceSinks ?? []).filter((e) => e.name !== name);
    const assignments = Object.fromEntries(
      Object.entries(s?.traceSinkByHarness ?? {}).filter(([, sink]) => sink !== name),
    );
    await this.settings.set(workspace, { traceSinks: next, traceSinkByHarness: assignments });
  }

  // 하니스별 싱크 선택(member+ — 하니스 구성의 일부). sink=null 은 선택 해제(적재 끔).
  // 없는 싱크 이름은 400 — dangling 참조를 조용히 만들지 않는다.
  async assign(workspace: string, harnessId: string, sink: string | null): Promise<Record<string, string>> {
    const s = await this.settings.get(workspace);
    const known = new Set((s?.traceSinks ?? []).map((e) => e.name));
    if (sink !== null && !known.has(sink))
      throw new BadRequestError("BAD_REQUEST", { sink }, `등록되지 않은 싱크입니다: ${sink}`);
    const assignments = { ...(s?.traceSinkByHarness ?? {}) };
    if (sink === null) delete assignments[harnessId];
    else assignments[harnessId] = sink;
    await this.settings.set(workspace, { traceSinkByHarness: assignments });
    return assignments;
  }

  // 케이스 스트리밍 export — 배치가 케이스 완성(judge 후) 즉시 push 해 팀 플랫폼에 케이스 단위로 나타나게
  // 한다(배치 전체 완료 대기 없음 — 라이브 가시성 + 실패 시 부분 보존). 준비(설정/선택/시크릿/빌더)는 스트림
  // 생성 시 1회. 선택 없음/빌더 미주입 → undefined(no-op, 현행 옵트인 시맨틱). 절대 throw 하지 않는다.
  // attach: pull 인제스트의 (source.kind, caseId→외부 runId) — 소스와 싱크가 같은 플랫폼일 때만 기존 trace 에
  // 점수를 부착(흐름②, 복제 없음)하고, 다르면 create 모드로 폴백(흐름①과 동일).
  // docs/architecture/streaming-case-pipeline.md D5 + docs/architecture/trace-sink.md
  async exportStream(
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string },
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ): Promise<CaseExportStream | undefined> {
    const s = await this.settings.get(tenant);
    // ctx.harness = "id@version" — 싱크 선택은 하니스 id 단위(버전 무관).
    const harnessId = ctx.harness.split("@")[0] ?? ctx.harness;
    const sinkName = s?.traceSinkByHarness?.[harnessId];
    const sink = sinkName ? (s?.traceSinks ?? []).find((e) => e.name === sinkName) : undefined;
    const buildSink = this.deps.buildSink;
    if (!sink || !buildSink) return undefined;
    const exportedAt = (this.deps.now ?? (() => new Date().toISOString()))();

    // 준비 실패(시크릿 미등록 등)는 스트림을 "실패 outcome 전용"으로 — push 는 무시되고 settle 이 사유를 반환.
    let impl: TraceSink | undefined;
    let initError: string | undefined;
    try {
      let auth: string | undefined;
      if (sink.authSecretName) {
        const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
        auth = secrets[sink.authSecretName];
        if (!auth) initError = `SecretStore 에 '${sink.authSecretName}' 값이 없습니다 — 시크릿을 먼저 등록하세요.`;
      }
      if (!initError) {
        impl = buildSink({
          kind: sink.kind,
          endpoint: sink.endpoint,
          ...(auth ? { auth } : {}),
          ...(sink.project ? { project: sink.project } : {}),
          ...(sink.webUrl ? { webUrl: sink.webUrl } : {}),
        });
      }
    } catch (err) {
      initError = err instanceof Error ? err.message : String(err);
    }
    const ids = attach && attach.sourceKind === sink.kind ? attach.externalIdByCase : undefined;
    const toSinkCase = (r: CaseResult): TraceSinkCase => {
      const externalId = ids?.[r.caseId];
      return {
        caseId: r.caseId,
        trace: r.trace,
        scores: r.scores.map((sc) => ({
          name: sc.metric,
          value: sc.value,
          ...(sc.pass !== undefined ? { pass: sc.pass } : {}),
          ...(typeof sc.detail === "string" && sc.detail !== "" ? { comment: sc.detail } : {}),
        })),
        ...(externalId ? { externalId } : {}),
      };
    };

    const limit = createLimiter(this.deps.exportConcurrency ?? 2);
    const tasks: Array<Promise<void>> = [];
    const outcomes: SinkCaseOutcome[] = []; // push 순서 보존(슬롯 선점 후 비동기 기록)
    let url: string | undefined;
    return {
      push: (result) => {
        const sinkImpl = impl;
        if (!sinkImpl) return; // 준비 실패 — settle 이 사유 반환(케이스 발사 없음)
        const slot = outcomes.length;
        outcomes.push({ caseId: result.caseId, error: "미완료" }); // 슬롯 선점 — 태스크가 덮어쓴다
        tasks.push(
          limit(async () => {
            try {
              const out = await sinkImpl.export(ctx, [toSinkCase(result)]);
              url ??= out.url;
              outcomes[slot] = out.cases[0] ?? { caseId: result.caseId, error: "싱크가 결과를 돌려주지 않음" };
            } catch (err) {
              // 케이스별 격리 — 한 케이스의 업스트림 실패가 다른 케이스/스코어카드를 막지 않는다.
              outcomes[slot] = { caseId: result.caseId, error: err instanceof Error ? err.message : String(err) };
            }
          }),
        );
      },
      settle: async () => {
        await Promise.all(tasks);
        if (initError) return { sink: sink.kind, name: sink.name, status: "failed", message: initError, exportedAt };
        const failed = outcomes.filter((c) => c.error).length;
        const status = failed === 0 ? "succeeded" : failed === outcomes.length && failed > 0 ? "failed" : "partial";
        // 전면 실패면 첫 에러 사유를 최상위로(케이스별 호출이라 wholesale 장애도 케이스에 격리됨 — 사유 승격),
        // 부분 실패면 개수 요약(케이스별 사유는 cases[].error 에).
        const message =
          status === "failed"
            ? outcomes.find((c) => c.error)?.error
            : failed > 0
              ? `${failed}/${outcomes.length}개 케이스 적재 실패`
              : undefined;
        return {
          sink: sink.kind,
          name: sink.name,
          status,
          ...(url ? { url } : {}),
          ...(message ? { message } : {}),
          exportedAt,
          cases: outcomes,
        };
      },
    };
  }

  // 채점 완료된 케이스 결과(trace+점수)를 '그 하니스가 선택한' 싱크로 적재 — 일괄 소비형(ingest 등 결과가
  // 이미 다 있는 경로). 내부적으로 스트림에 전부 push 후 합류(코어는 exportStream 하나).
  async exportScorecard(
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string },
    results: CaseResult[],
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ): Promise<ScorecardExport | undefined> {
    const stream = await this.exportStream(tenant, ctx, attach);
    if (!stream) return undefined;
    for (const r of results) stream.push(r);
    return stream.settle();
  }
}
