import type { CaseResult } from "@assay/core";
import type { ScorecardExport, WorkspaceSettings, WorkspaceSettingsStore } from "@assay/db";
import type { TraceSink, TraceSinkCase, TraceSinkConfig } from "@assay/trace";

// 워크스페이스 트레이스 싱크 통합 — judge 된 스코어카드 상세 결과를 팀 관측 플랫폼(MLflow/Langfuse/LangSmith/Phoenix)에
// 적재하는 아웃바운드 설정. 스코어카드는 요약+외부 딥링크만 소개한다(플랫폼이 상세의 진실원천).
// 비밀 없음: authSecretName 은 값이 아닌 SecretStore 이름 참조라 반환 안전. HTTP 라우트와 MCP 도구가 이 코어를 공유.
// 설계: docs/architecture/trace-sink.md

// 워크스페이스 트레이스 싱크 현황(비밀 없음 — 전부 이름 참조/URL).
export interface TraceSinkConfigView {
  kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
  endpoint: string;
  authSecretName?: string;
  project?: string;
  webUrl?: string;
}

type TraceSinkSettings = NonNullable<WorkspaceSettings["traceSink"]>;

export interface TraceSinkServiceDeps {
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // authSecretName → 값 resolve(워크스페이스 SecretStore)
  buildSink?: (cfg: TraceSinkConfig) => TraceSink; // 설정 → 어댑터(@assay/trace buildTraceSink). 미주입이면 적재 비활성
  now?: () => string;
}

export class TraceSinkService {
  constructor(
    private readonly settings: WorkspaceSettingsStore,
    private readonly deps: TraceSinkServiceDeps = {},
  ) {}

  // 채점 완료된 케이스 결과(trace+점수)를 워크스페이스 싱크로 적재. 싱크 미설정/빌더 미주입 → undefined(no-op).
  // 절대 throw 하지 않는다 — 어떤 실패든 {status:"failed", message} 로 기록해 스코어카드 결과와 격리한다.
  // attach: pull 인제스트의 (source.kind, caseId→외부 runId) — 소스와 싱크가 같은 플랫폼일 때만 기존 trace 에
  // 점수를 부착(흐름②, 복제 없음)하고, 다르면 create 모드로 폴백(흐름①과 동일).
  async exportScorecard(
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string },
    results: CaseResult[],
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ): Promise<ScorecardExport | undefined> {
    const sink = (await this.settings.get(tenant))?.traceSink;
    if (!sink || !this.deps.buildSink) return undefined;
    const exportedAt = (this.deps.now ?? (() => new Date().toISOString()))();
    try {
      let auth: string | undefined;
      if (sink.authSecretName) {
        const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
        auth = secrets[sink.authSecretName];
        if (!auth)
          return {
            sink: sink.kind,
            status: "failed",
            message: `SecretStore 에 '${sink.authSecretName}' 값이 없습니다 — 시크릿을 먼저 등록하세요.`,
            exportedAt,
          };
      }
      const impl = this.deps.buildSink({
        kind: sink.kind,
        endpoint: sink.endpoint,
        ...(auth ? { auth } : {}),
        ...(sink.project ? { project: sink.project } : {}),
        ...(sink.webUrl ? { webUrl: sink.webUrl } : {}),
      });
      const ids = attach && attach.sourceKind === sink.kind ? attach.externalIdByCase : undefined;
      const cases: TraceSinkCase[] = results.map((r) => {
        const externalId = ids?.[r.caseId];
        return {
          caseId: r.caseId,
          trace: r.trace,
          scores: r.scores.map((s) => ({
            name: s.metric,
            value: s.value,
            ...(s.pass !== undefined ? { pass: s.pass } : {}),
            ...(typeof s.detail === "string" && s.detail !== "" ? { comment: s.detail } : {}),
          })),
          ...(externalId ? { externalId } : {}),
        };
      });
      const out = await impl.export(ctx, cases);
      const failed = out.cases.filter((c) => c.error).length;
      const status = failed === 0 ? "succeeded" : failed === out.cases.length ? "failed" : "partial";
      return {
        sink: sink.kind,
        status,
        ...(out.url ? { url: out.url } : {}),
        ...(failed > 0 ? { message: `${failed}/${out.cases.length}개 케이스 적재 실패` } : {}),
        exportedAt,
        cases: out.cases,
      };
    } catch (err) {
      // UpstreamError 포함 전면 실패 — 스코어카드에 영향 없이 사유만 기록.
      return {
        sink: sink.kind,
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
        exportedAt,
      };
    }
  }

  async get(workspace: string): Promise<TraceSinkConfigView | undefined> {
    const sink = (await this.settings.get(workspace))?.traceSink;
    if (!sink) return undefined; // null(클리어됨) 또는 미설정
    return {
      kind: sink.kind,
      endpoint: sink.endpoint,
      ...(sink.authSecretName ? { authSecretName: sink.authSecretName } : {}),
      ...(sink.project ? { project: sink.project } : {}),
      ...(sink.webUrl ? { webUrl: sink.webUrl } : {}),
    };
  }

  // 등록/갱신(관리자, 선언형 전체 교체). 인증 토큰(값)은 SecretStore 에 먼저 넣고 그 이름만 지정.
  async set(
    workspace: string,
    input: {
      kind: "mlflow" | "langfuse" | "langsmith" | "phoenix";
      endpoint: string;
      authSecretName?: string;
      project?: string;
      webUrl?: string;
    },
  ): Promise<TraceSinkConfigView> {
    const next: TraceSinkSettings = {
      kind: input.kind,
      endpoint: input.endpoint,
      ...(input.authSecretName ? { authSecretName: input.authSecretName } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.webUrl ? { webUrl: input.webUrl } : {}),
    };
    await this.settings.set(workspace, { traceSink: next });
    const got = await this.get(workspace);
    return got ?? { kind: next.kind, endpoint: next.endpoint };
  }

  // 해제(관리자). jsonb 병합 || 은 키 삭제 불가라 null 로 무효화한다(읽을 때 undefined 취급).
  async clear(workspace: string): Promise<void> {
    await this.settings.set(workspace, { traceSink: null });
  }
}
