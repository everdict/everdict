import type { WorkspaceSettings, WorkspaceSettingsStore } from "@everdict/db";

// 워크스페이스 소유 Mattermost 통합 서비스 — 사내 Mattermost 를 관리자가 워크스페이스에 1회 등록(개인 연결 알림 대체).
// 아웃바운드 알림은 NotificationService 가 settings.mattermost 를 읽어 bot 토큰으로 게시한다.
// 비밀 없음: botTokenSecretName 은 값이 아닌 SecretStore 이름 참조라 반환 안전. HTTP 라우트와 MCP 도구가 이 코어를 공유.
// 설계: docs/architecture/workspace-scoped-integrations.md

// 워크스페이스 Mattermost 현황(비밀 없음 — 전부 이름 참조/URL). 인바운드 URL 은 관리자가 MM 슬래시커맨드/액션에 등록.
export interface MattermostConfigView {
  host: string;
  botTokenSecretName: string;
  defaultChannelId?: string;
  // 인바운드(슬래시커맨드/버튼) 검증 토큰의 SecretStore 이름. 설정하면 /everdict 커맨드·버튼이 활성.
  commandTokenSecretName?: string;
  // 관리자가 MM 쪽에 등록할 인바운드 URL(apiPublicUrl 기반). commandTokenSecretName 설정 시에만 의미 있음.
  commandUrl?: string;
  actionUrl?: string;
}

export interface MattermostServiceConfig {
  apiPublicUrl?: string; // 인바운드 URL(슬래시커맨드/액션) 베이스. 미설정이면 URL 미노출.
}

type MattermostSettings = NonNullable<WorkspaceSettings["mattermost"]>;

export class MattermostService {
  constructor(
    private readonly settings: WorkspaceSettingsStore,
    private readonly config: MattermostServiceConfig = {},
  ) {}

  // 워크스페이스 슬러그를 인바운드 URL 에 실어 라우팅한다(슬러그는 비밀 아님 — 진위는 commandToken 검증이 담당).
  private inboundUrls(workspace: string): { commandUrl?: string; actionUrl?: string } {
    const base = this.config.apiPublicUrl;
    if (!base) return {};
    const b = base.endsWith("/") ? base.slice(0, -1) : base;
    const ws = encodeURIComponent(workspace);
    return {
      commandUrl: `${b}/integrations/mattermost/command?ws=${ws}`,
      actionUrl: `${b}/integrations/mattermost/action?ws=${ws}`,
    };
  }

  async get(workspace: string): Promise<MattermostConfigView | undefined> {
    const mm = (await this.settings.get(workspace))?.mattermost;
    if (!mm) return undefined; // null(클리어됨) 또는 미설정
    const urls = mm.commandTokenSecretName ? this.inboundUrls(workspace) : {};
    return {
      host: mm.host,
      botTokenSecretName: mm.botTokenSecretName,
      ...(mm.defaultChannelId ? { defaultChannelId: mm.defaultChannelId } : {}),
      ...(mm.commandTokenSecretName ? { commandTokenSecretName: mm.commandTokenSecretName } : {}),
      ...(urls.commandUrl ? { commandUrl: urls.commandUrl } : {}),
      ...(urls.actionUrl ? { actionUrl: urls.actionUrl } : {}),
    };
  }

  // 등록/갱신(관리자). bot 토큰(값)은 SecretStore 에 먼저 넣고 그 이름만 지정. commandTokenSecretName 은 인바운드 검증 토큰.
  async set(
    workspace: string,
    input: {
      host: string;
      botTokenSecretName: string;
      defaultChannelId?: string;
      commandTokenSecretName?: string;
    },
  ): Promise<MattermostConfigView> {
    const existing = (await this.settings.get(workspace))?.mattermost ?? undefined;
    const defaultChannelId = input.defaultChannelId ?? existing?.defaultChannelId;
    const commandTokenSecretName = input.commandTokenSecretName ?? existing?.commandTokenSecretName;
    const next: MattermostSettings = {
      host: input.host,
      botTokenSecretName: input.botTokenSecretName,
      ...(defaultChannelId ? { defaultChannelId } : {}),
      ...(commandTokenSecretName ? { commandTokenSecretName } : {}),
    };
    await this.settings.set(workspace, { mattermost: next });
    const got = await this.get(workspace);
    return got ?? { host: next.host, botTokenSecretName: next.botTokenSecretName };
  }

  // 해제(관리자). jsonb 병합 || 은 키 삭제 불가라 null 로 무효화한다(읽을 때 undefined 취급).
  async clear(workspace: string): Promise<void> {
    await this.settings.set(workspace, { mattermost: null });
  }
}
