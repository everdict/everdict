import { BadRequestError } from "@assay/core";
import {
  type OAuthStateStore,
  type WorkspaceSettings,
  type WorkspaceSettingsStore,
  generateOAuthState,
} from "@assay/db";
import { getInstallation } from "./oauth/github-app.js";

// 워크스페이스 소유 GitHub App 통합 서비스 — 개인 Connected accounts(OAuth 토큰) 대체.
// 조직 설치→선택 repo→워크스페이스 소유 installation. github.com App = operator env(config.githubCom);
// GHE App = 관리자가 워크스페이스에 host+slug+appId+privateKeySecretName 등록(개인키=SecretStore name-ref).
// HTTP 라우트와 MCP 도구가 이 코어를 공유(BFF↔MCP 패리티). 개인키/토큰 값은 절대 브라우저로 안 나간다.
// 설계: docs/architecture/workspace-scoped-integrations.md

type GithubAppSettings = NonNullable<WorkspaceSettings["githubApp"]>;
type Registration = GithubAppSettings["registrations"][number];
type Installation = GithubAppSettings["installations"][number];

// operator github.com App 자격증명(env). 미설정이면 github.com App 비활성(GHE 는 워크스페이스 등록으로 가능).
export interface GithubComAppConfig {
  appId: string;
  privateKeyPem: string;
  slug: string; // 설치 URL github.com/apps/{slug}/installations/new 에 사용
}

export interface GithubAppServiceConfig {
  webBaseUrl: string; // 콜백 후 브라우저 복귀 웹 베이스(예: http://localhost:3001)
  apiPublicUrl?: string; // 설치 콜백(App Setup URL) 베이스. 미설정이면 요청 base 폴백.
  stateTtlSec?: number; // pending state 만료(기본 600s)
  githubCom?: GithubComAppConfig; // env 기본 github.com App(없으면 github.com 설치 비활성)
}

// 워크스페이스 App 통합 현황(비밀 없음 — privateKeySecretName 은 값이 아닌 이름 참조라 반환 안전).
export interface GithubAppView {
  registrations: Registration[];
  installations: Installation[];
}

export interface StartInstallInput {
  workspace: string;
  createdBy: string;
  host?: string; // 미지정 = github.com(env App), 지정 = 그 GHE 등록
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export class GithubAppService {
  private readonly states: OAuthStateStore;
  private readonly settings: WorkspaceSettingsStore;
  private readonly secretsFor: (workspace: string) => Promise<Record<string, string>>;
  private readonly config: GithubAppServiceConfig;
  private readonly now: () => Date;
  constructor(deps: {
    states: OAuthStateStore;
    settings: WorkspaceSettingsStore;
    secretsFor: (workspace: string) => Promise<Record<string, string>>;
    config: GithubAppServiceConfig;
    now?: () => Date;
  }) {
    this.states = deps.states;
    this.settings = deps.settings;
    this.secretsFor = deps.secretsFor;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  // 워크스페이스 App 통합 현황(등록 + 설치). 비밀 값 없음.
  async list(workspace: string): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    return { registrations: g?.registrations ?? [], installations: g?.installations ?? [] };
  }

  // GHE App 등록/갱신(관리자). host 기준 upsert. 개인키는 SecretStore 에 먼저 넣고 그 이름을 지정.
  async registerGheApp(workspace: string, input: Registration): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    const registrations = [...(g?.registrations ?? []).filter((r) => r.host !== input.host), input];
    await this.write(workspace, { registrations, installations: g?.installations ?? [] });
    return { registrations, installations: g?.installations ?? [] };
  }

  // GHE App 등록 해제(관리자). 기존 installation 레코드는 남지만 자격증명이 없어 토큰 발급 불가.
  async removeRegistration(workspace: string, host: string): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    if (!g) return { registrations: [], installations: [] };
    const registrations = g.registrations.filter((r) => r.host !== host);
    await this.write(workspace, { registrations, installations: g.installations });
    return { registrations, installations: g.installations };
  }

  // installation 링크 해제(관리자). 실제 uninstall 은 GitHub 쪽 — 여기선 레코드만 잊는다(멱등).
  async unlinkInstallation(workspace: string, installationId: number): Promise<GithubAppView> {
    const g = (await this.settings.get(workspace))?.githubApp;
    if (!g) return { registrations: [], installations: [] };
    const installations = g.installations.filter((i) => i.installationId !== installationId);
    await this.write(workspace, { registrations: g.registrations, installations });
    return { registrations: g.registrations, installations };
  }

  // 설치 시작 → GitHub App 설치 페이지 URL(state 포함). 관리자가 클릭 → GitHub 에서 repo 선택 → 콜백.
  async startInstall(input: StartInstallInput): Promise<{ installUrl: string }> {
    const target = await this.resolveInstallTarget(input.workspace, input.host);
    const state = generateOAuthState();
    const expiresAt = new Date(this.now().getTime() + (this.config.stateTtlSec ?? 600) * 1000).toISOString();
    await this.states.put(
      state,
      {
        workspace: input.workspace,
        provider: "github-app",
        createdBy: input.createdBy,
        ...(input.host ? { host: input.host } : {}),
      },
      expiresAt,
    );
    const u = new URL(`${target.webBase}${target.installPath}/${target.slug}/installations/new`);
    u.searchParams.set("state", state);
    return { installUrl: u.toString() };
  }

  // 설치 콜백 — installation_id + state → account 확정 후 워크스페이스에 installation 기록(upsert).
  // GitHub 은 setup_action(install|update) 에 무관하게 installation_id 를 준다 → 항상 upsert.
  async callback(input: { installationId?: number; state?: string }): Promise<{ redirectTo: string }> {
    if (!input.state) return { redirectTo: this.errorRedirect(undefined, "missing_state") };
    const pending = await this.states.take(input.state); // 1회용 — 만료/재사용은 null
    if (!pending) return { redirectTo: this.errorRedirect(undefined, "invalid_state") };
    if (input.installationId === undefined)
      return { redirectTo: this.errorRedirect(pending.workspace, "missing_installation") };
    try {
      const creds = await this.resolveAppCreds(pending.workspace, pending.host);
      const { account } = await getInstallation({
        ...(pending.host ? { host: pending.host } : {}),
        appId: creds.appId,
        privateKeyPem: creds.privateKeyPem,
        installationId: input.installationId,
        nowSec: this.nowSec(),
      });
      const g = (await this.settings.get(pending.workspace))?.githubApp;
      const record: Installation = {
        installationId: input.installationId,
        account,
        connectedBy: pending.createdBy,
        connectedAt: this.now().toISOString(),
        ...(pending.host ? { host: pending.host } : {}),
      };
      const installations = [
        ...(g?.installations ?? []).filter((i) => i.installationId !== input.installationId),
        record,
      ];
      await this.write(pending.workspace, { registrations: g?.registrations ?? [], installations });
      return { redirectTo: this.successRedirect(pending.workspace) };
    } catch {
      // 자격증명 resolve / installation 조회 실패 — 브라우저엔 에러 콜아웃으로(원시 에러 노출 금지).
      return { redirectTo: this.errorRedirect(pending.workspace, "install_failed") };
    }
  }

  // App Setup URL 로 등록할 콜백 URL(관리자 표시용). apiPublicUrl 우선, 없으면 요청 base.
  callbackUrl(requestBaseUrl?: string): string | undefined {
    const base = this.config.apiPublicUrl ?? requestBaseUrl;
    return base ? `${trimSlash(base)}/workspace/github-app/callback` : undefined;
  }

  private nowSec(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  private async write(workspace: string, githubApp: GithubAppSettings): Promise<void> {
    // settings.set 은 top-level 얕은 병합 → githubApp 전체(등록+설치)를 항상 함께 쓴다.
    await this.settings.set(workspace, { githubApp });
  }

  private async resolveInstallTarget(
    workspace: string,
    host?: string,
  ): Promise<{ slug: string; webBase: string; installPath: string }> {
    if (!host) {
      const gc = this.config.githubCom;
      if (!gc) throw new BadRequestError("BAD_REQUEST", {}, "github.com App 미설정입니다(GITHUB_APP_* env).");
      return { slug: gc.slug, webBase: "https://github.com", installPath: "/apps" };
    }
    const reg = (await this.settings.get(workspace))?.githubApp?.registrations.find((r) => r.host === host);
    if (!reg) throw new BadRequestError("BAD_REQUEST", { host }, `등록되지 않은 GHE App host 입니다: ${host}`);
    return { slug: reg.slug, webBase: trimSlash(host), installPath: "/github-apps" };
  }

  private async resolveAppCreds(workspace: string, host?: string): Promise<{ appId: string; privateKeyPem: string }> {
    if (!host) {
      const gc = this.config.githubCom;
      if (!gc) throw new BadRequestError("BAD_REQUEST", {}, "github.com App 미설정입니다(GITHUB_APP_* env).");
      return { appId: gc.appId, privateKeyPem: gc.privateKeyPem };
    }
    const reg = (await this.settings.get(workspace))?.githubApp?.registrations.find((r) => r.host === host);
    if (!reg) throw new BadRequestError("BAD_REQUEST", { host }, `등록되지 않은 GHE App host 입니다: ${host}`);
    const pem = (await this.secretsFor(workspace))[reg.privateKeySecretName];
    if (!pem)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name: reg.privateKeySecretName },
        `SecretStore 에 App 개인키가 없습니다: ${reg.privateKeySecretName}`,
      );
    return { appId: reg.appId, privateKeyPem: pem };
  }

  private settingsUrl(workspace: string): string {
    return `${trimSlash(this.config.webBaseUrl)}/${encodeURIComponent(workspace)}/settings?tab=integrations`;
  }
  private successRedirect(workspace: string): string {
    return `${this.settingsUrl(workspace)}&githubApp=installed`;
  }
  private errorRedirect(workspace: string | undefined, reason: string): string {
    if (workspace === undefined) return `${trimSlash(this.config.webBaseUrl)}/?error=${encodeURIComponent(reason)}`;
    return `${this.settingsUrl(workspace)}&error=${encodeURIComponent(reason)}`;
  }
}
