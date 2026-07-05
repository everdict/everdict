import type { WorkspaceSettings, WorkspaceSettingsStore } from "@assay/db";

// 워크스페이스 소유 Mattermost 통합 서비스 — 사내 Mattermost 를 관리자가 워크스페이스에 1회 등록(개인 연결 알림 대체).
// 아웃바운드 알림은 NotificationService 가 settings.mattermost 를 읽어 bot 토큰으로 게시한다.
// 비밀 없음: botTokenSecretName 은 값이 아닌 SecretStore 이름 참조라 반환 안전. HTTP 라우트와 MCP 도구가 이 코어를 공유.
// 설계: docs/architecture/workspace-scoped-integrations.md

// 워크스페이스 Mattermost 현황(비밀 없음). 인바운드(commandToken/inboundToken)는 S7/S8 — 여기선 노출 안 함.
export interface MattermostConfigView {
  host: string;
  botTokenSecretName: string;
  defaultChannelId?: string;
}

type MattermostSettings = NonNullable<WorkspaceSettings["mattermost"]>;

export class MattermostService {
  constructor(private readonly settings: WorkspaceSettingsStore) {}

  async get(workspace: string): Promise<MattermostConfigView | undefined> {
    const mm = (await this.settings.get(workspace))?.mattermost;
    if (!mm) return undefined; // null(클리어됨) 또는 미설정
    return {
      host: mm.host,
      botTokenSecretName: mm.botTokenSecretName,
      ...(mm.defaultChannelId ? { defaultChannelId: mm.defaultChannelId } : {}),
    };
  }

  // 등록/갱신(관리자). bot 토큰(값)은 SecretStore 에 먼저 넣고 그 이름만 지정. S7/S8 인바운드 필드는 보존.
  async set(
    workspace: string,
    input: { host: string; botTokenSecretName: string; defaultChannelId?: string },
  ): Promise<MattermostConfigView> {
    const existing = (await this.settings.get(workspace))?.mattermost ?? undefined;
    const defaultChannelId = input.defaultChannelId ?? existing?.defaultChannelId;
    const next: MattermostSettings = {
      host: input.host,
      botTokenSecretName: input.botTokenSecretName,
      ...(defaultChannelId ? { defaultChannelId } : {}),
      ...(existing?.commandTokenSecretName ? { commandTokenSecretName: existing.commandTokenSecretName } : {}),
      ...(existing?.inboundToken ? { inboundToken: existing.inboundToken } : {}),
    };
    await this.settings.set(workspace, { mattermost: next });
    return {
      host: next.host,
      botTokenSecretName: next.botTokenSecretName,
      ...(next.defaultChannelId ? { defaultChannelId: next.defaultChannelId } : {}),
    };
  }

  // 해제(관리자). jsonb 병합 || 은 키 삭제 불가라 null 로 무효화한다(읽을 때 undefined 취급).
  async clear(workspace: string): Promise<void> {
    await this.settings.set(workspace, { mattermost: null });
  }
}
