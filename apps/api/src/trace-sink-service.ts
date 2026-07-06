import { BadRequestError, type CaseResult } from "@assay/core";
import type { ScorecardExport, WorkspaceSettings, WorkspaceSettingsStore } from "@assay/db";
import type { TraceSink, TraceSinkCase, TraceSinkConfig } from "@assay/trace";

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
  now?: () => string;
}

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

  // 채점 완료된 케이스 결과(trace+점수)를 '그 하니스가 선택한' 싱크로 적재. 선택 없음/빌더 미주입 → undefined(no-op).
  // 절대 throw 하지 않는다 — 어떤 실패든 {status:"failed", message} 로 기록해 스코어카드 결과와 격리한다.
  // attach: pull 인제스트의 (source.kind, caseId→외부 runId) — 소스와 싱크가 같은 플랫폼일 때만 기존 trace 에
  // 점수를 부착(흐름②, 복제 없음)하고, 다르면 create 모드로 폴백(흐름①과 동일).
  async exportScorecard(
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string },
    results: CaseResult[],
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ): Promise<ScorecardExport | undefined> {
    const s = await this.settings.get(tenant);
    // ctx.harness = "id@version" — 싱크 선택은 하니스 id 단위(버전 무관).
    const harnessId = ctx.harness.split("@")[0] ?? ctx.harness;
    const sinkName = s?.traceSinkByHarness?.[harnessId];
    const sink = sinkName ? (s?.traceSinks ?? []).find((e) => e.name === sinkName) : undefined;
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
            name: sink.name,
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
          scores: r.scores.map((sc) => ({
            name: sc.metric,
            value: sc.value,
            ...(sc.pass !== undefined ? { pass: sc.pass } : {}),
            ...(typeof sc.detail === "string" && sc.detail !== "" ? { comment: sc.detail } : {}),
          })),
          ...(externalId ? { externalId } : {}),
        };
      });
      const out = await impl.export(ctx, cases);
      const failed = out.cases.filter((c) => c.error).length;
      const status = failed === 0 ? "succeeded" : failed === out.cases.length ? "failed" : "partial";
      return {
        sink: sink.kind,
        name: sink.name,
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
        name: sink.name,
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
        exportedAt,
      };
    }
  }
}
