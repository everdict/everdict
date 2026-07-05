import type {
  ConnectionMeta,
  ConnectionToken,
  NotificationListOptions,
  NotificationRecord,
  NotificationStore,
  RunRecord,
  WorkspaceSettings,
} from "@assay/db";

// 완료 알림 — 한 완료 이벤트가 [개인 피드, Mattermost] 두 채널로 팬아웃된다(docs/architecture/notifications.md N5).
// 피드: 개인(recipient=레코드 createdBy) 인박스 — 웹 벨/데스크톱 네이티브 알림이 소비(N1/N2).
// Mattermost: 워크스페이스 notify 설정이 있으면 채널 게시(기존 연결계정 소비 슬라이스).
// 알림 실패는 run/scorecard 결과에 영향 없음(fire-and-forget — 스토어가 진실원천, 폴링으로도 조회 가능).
export interface NotificationServiceDeps {
  settingsFor: (tenant: string) => Promise<WorkspaceSettings | undefined>;
  // 워크스페이스 Mattermost(bot 토큰) — settings.mattermost.botTokenSecretName 을 워크스페이스 SecretStore 에서 resolve.
  secretsFor?: (tenant: string) => Promise<Record<string, string>>;
  // (레거시) 연결은 개인 소유(owner=subject)로 조회 — notify 설정의 ownerSubject 토큰으로 게시. S6 에서 제거.
  connections: {
    list: (owner: string) => Promise<ConnectionMeta[]>;
    tokenFor: (owner: string, id: string) => Promise<ConnectionToken | null>;
  };
  feed?: NotificationStore; // 개인 알림 피드 — 미설정이면 피드 채널만 조용히 생략
  fetch?: typeof fetch;
  newId?: () => string;
  now?: () => string;
}

export class NotificationService {
  private readonly fetchImpl: typeof fetch;
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  constructor(private readonly deps: NotificationServiceDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.nowIso = deps.now ?? (() => new Date().toISOString());
  }

  async notifyRun(tenant: string, record: RunRecord): Promise<void> {
    // 피드(N2): 실행자가 알려진 최상위 run 만 — 스코어카드 자식 run 은 배치 1건으로 갈음(범람 방지).
    if (record.createdBy && !record.parentScorecardId && (record.status === "succeeded" || record.status === "failed"))
      await this.pushFeed({
        workspace: tenant,
        recipient: record.createdBy,
        kind: record.status === "succeeded" ? "run_completed" : "run_failed",
        title: `Run ${record.status === "succeeded" ? "완료" : "실패"} — ${record.harness.id}@${record.harness.version}`,
        body: `case ${record.caseId}`,
        link: { runId: record.id },
      });
    const icon = record.status === "succeeded" ? "✅" : record.status === "failed" ? "❌" : "•";
    await this.post(
      tenant,
      `${icon} **Run \`${record.id}\`** ${record.status} — \`${record.harness.id}@${record.harness.version}\` (case ${record.caseId})`,
    );
  }

  async notifyScorecard(
    tenant: string,
    record: {
      id: string;
      status: string;
      dataset: { id: string; version: string };
      harness: { id: string; version: string };
      createdBy?: string;
    },
  ): Promise<void> {
    if (record.createdBy && (record.status === "succeeded" || record.status === "failed"))
      await this.pushFeed({
        workspace: tenant,
        recipient: record.createdBy,
        kind: record.status === "succeeded" ? "scorecard_completed" : "scorecard_failed",
        title: `스코어카드 ${record.status === "succeeded" ? "완료" : "실패"} — ${record.dataset.id}@${record.dataset.version} × ${record.harness.id}@${record.harness.version}`,
        link: { scorecardId: record.id },
      });
    const icon = record.status === "succeeded" ? "✅" : record.status === "failed" ? "❌" : "•";
    await this.post(
      tenant,
      `${icon} **Scorecard \`${record.id}\`** ${record.status} — dataset \`${record.dataset.id}@${record.dataset.version}\` × \`${record.harness.id}@${record.harness.version}\``,
    );
  }

  // --- 개인 피드(벨 인박스) — self-scoped(connections/runners 와 동일), 역할 게이트 없음 ---

  listFeed(recipient: string, workspace: string, opts?: NotificationListOptions): Promise<NotificationRecord[]> {
    return this.deps.feed?.list(recipient, workspace, opts) ?? Promise.resolve([]);
  }

  markFeedRead(recipient: string, workspace: string, ids: string[] | "all"): Promise<number> {
    return this.deps.feed?.markRead(recipient, workspace, ids, this.nowIso()) ?? Promise.resolve(0);
  }

  // 댓글 @멘션 — 언급된 유저(들)에게 개인 피드 알림. 링크는 그 컨텍스트(데이터셋 댓글, commentId 앵커)로.
  // recipients = 멘션된 subject 들(작성자 자기 자신은 호출부에서 제외). 채널 게시는 하지 않는다(피드 전용, 저소음).
  async notifyMention(
    tenant: string,
    input: {
      recipients: string[];
      actorName: string; // 언급한 사람의 표시명(이름/유저네임)
      resourceType: string; // "dataset" 등
      resourceId: string;
      commentId: string;
      preview: string; // 댓글 본문 미리보기
    },
  ): Promise<void> {
    const preview = input.preview.trim().replace(/\s+/g, " ").slice(0, 140);
    for (const recipient of [...new Set(input.recipients)]) {
      await this.pushFeed({
        workspace: tenant,
        recipient,
        kind: "comment_mention",
        title: `${input.actorName}님이 회원님을 언급했어요`,
        body: preview,
        // 리소스 제네릭 링크 — 웹이 resourceType→경로 매핑 + commentId 앵커로 그 댓글까지 스크롤.
        link: { resourceType: input.resourceType, resourceId: input.resourceId, commentId: input.commentId },
      });
    }
  }

  // 피드 적재 — Mattermost 와 독립적으로 실패를 삼킨다(한 채널 장애가 다른 채널을 막지 않게).
  private async pushFeed(row: Omit<NotificationRecord, "id" | "createdAt">): Promise<void> {
    if (!this.deps.feed) return;
    try {
      await this.deps.feed.add({ ...row, id: this.newId(), createdAt: this.nowIso() });
    } catch {
      // 피드 실패는 결과에 영향 없음.
    }
  }

  // 예약(cron) 회귀 알림 — 직전 스케줄 run 대비 회귀가 잡히면 채널에 고신호 경고를 게시(완료 알림과 별개).
  async notifyRegression(
    tenant: string,
    payload: {
      scheduleName: string;
      scorecardId: string;
      previousScorecardId: string;
      regressions: Array<{ caseId: string; metric: string; baseline: number; candidate: number }>;
      createdBy?: string; // 예약 생성자 — 개인 피드 수신자(N2)
    },
  ): Promise<void> {
    if (payload.createdBy)
      await this.pushFeed({
        workspace: tenant,
        recipient: payload.createdBy,
        kind: "schedule_regression",
        title: `예약 회귀 — ${payload.scheduleName} (${payload.regressions.length}건)`,
        body: payload.regressions
          .slice(0, 3)
          .map((r) => `${r.caseId} ${r.metric}: ${r.baseline} → ${r.candidate}`)
          .join(" · "),
        link: { scorecardId: payload.scorecardId },
      });
    const lines = payload.regressions
      .slice(0, 10)
      .map((r) => `• \`${r.caseId}\` ${r.metric}: ${r.baseline} → ${r.candidate}`)
      .join("\n");
    const more = payload.regressions.length > 10 ? `\n…외 ${payload.regressions.length - 10}건` : "";
    await this.post(
      tenant,
      `⚠️ **예약 회귀 \`${payload.scheduleName}\`** — ${payload.regressions.length}건 회귀 ` +
        `(scorecard \`${payload.scorecardId}\` vs 직전 \`${payload.previousScorecardId}\`)\n${lines}${more}`,
    );
  }

  // Mattermost 채널에 게시. 워크스페이스 등록(bot 토큰)을 우선하고, 없으면 (레거시) 개인 연결 notify 로 폴백.
  // 미설정/토큰없음/실패는 조용히 무시(알림 실패는 run/scorecard 결과에 영향 없음).
  private async post(tenant: string, message: string): Promise<void> {
    try {
      const settings = await this.deps.settingsFor(tenant);
      // 1) 워크스페이스 소유 Mattermost(bot 토큰) — 우선. defaultChannelId + SecretStore 의 bot 토큰이 있어야 게시.
      const mm = settings?.mattermost;
      if (mm?.defaultChannelId && this.deps.secretsFor) {
        const token = (await this.deps.secretsFor(tenant))[mm.botTokenSecretName];
        if (token) {
          const base = mm.host.endsWith("/") ? mm.host.slice(0, -1) : mm.host;
          await this.fetchImpl(`${base}/api/v4/posts`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ channel_id: mm.defaultChannelId, message }),
          });
          return;
        }
      }
      // 2) (레거시) 개인 소유 연결 notify — ownerSubject 의 토큰으로 게시. S6 에서 제거.
      const cfg = settings?.notify;
      if (!cfg || !cfg.ownerSubject) return;
      const conn = (await this.deps.connections.list(cfg.ownerSubject)).find((c) => c.id === cfg.connectionId);
      if (!conn || conn.provider !== "mattermost" || !conn.host) return;
      const tok = await this.deps.connections.tokenFor(cfg.ownerSubject, cfg.connectionId);
      if (!tok) return;
      const base = conn.host.endsWith("/") ? conn.host.slice(0, -1) : conn.host;
      await this.fetchImpl(`${base}/api/v4/posts`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ channel_id: cfg.channelId, message }),
      });
    } catch {
      // 알림 실패는 run/scorecard 결과에 영향 없음.
    }
  }
}
