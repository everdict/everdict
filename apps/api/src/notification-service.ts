import type { ConnectionMeta, ConnectionToken, RunRecord, WorkspaceSettings } from "@assay/db";

// 완료 알림 — 워크스페이스에 Mattermost 연결 notify 가 설정돼 있으면 채널에 게시.
// 외부 계정 연결(Connected accounts)의 "소비" 슬라이스: 저장된 Mattermost 토큰으로 run/scorecard 완료를 알린다.
// 알림 실패는 run 결과에 영향 없음(fire-and-forget — 스토어가 진실원천, 폴링으로도 조회 가능).
export interface NotificationServiceDeps {
  settingsFor: (tenant: string) => Promise<WorkspaceSettings | undefined>;
  // 연결은 개인 소유(owner=subject)로 조회 — notify 설정에 박힌 ownerSubject 의 토큰으로 게시한다.
  connections: {
    list: (owner: string) => Promise<ConnectionMeta[]>;
    tokenFor: (owner: string, id: string) => Promise<ConnectionToken | null>;
  };
  fetch?: typeof fetch;
}

export class NotificationService {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly deps: NotificationServiceDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async notifyRun(tenant: string, record: RunRecord): Promise<void> {
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
    },
  ): Promise<void> {
    const icon = record.status === "succeeded" ? "✅" : record.status === "failed" ? "❌" : "•";
    await this.post(
      tenant,
      `${icon} **Scorecard \`${record.id}\`** ${record.status} — dataset \`${record.dataset.id}@${record.dataset.version}\` × \`${record.harness.id}@${record.harness.version}\``,
    );
  }

  // notify 대상(Mattermost 연결)이 설정돼 있으면 채널에 게시. 미설정/owner없음/비-Mattermost/토큰없음/실패는 조용히 무시.
  private async post(tenant: string, message: string): Promise<void> {
    try {
      const cfg = (await this.deps.settingsFor(tenant))?.notify;
      if (!cfg) return;
      // 개인 소유 연결: notify 를 설정한 사람(ownerSubject)의 토큰으로 게시. ownerSubject 없으면(구 설정) 누구 토큰인지 모르므로 skip.
      if (!cfg.ownerSubject) return;
      const conn = (await this.deps.connections.list(cfg.ownerSubject)).find((c) => c.id === cfg.connectionId);
      if (!conn || conn.provider !== "mattermost" || !conn.host) return; // notify 는 Mattermost 만(host 필요)
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
