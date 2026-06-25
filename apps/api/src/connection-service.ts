import { BadRequestError } from "@assay/core";
import {
  type ConnectionMeta,
  type ConnectionStore,
  type CreateConnectionInput,
  type OAuthStateStore,
  type WorkspaceIntegrationConfig,
  type WorkspaceSettingsStore,
  generateOAuthState,
} from "@assay/db";
import type { OAuthProvider, OAuthProviderConfig } from "./oauth/provider.js";

// 외부 계정 연결(Connected accounts) 서비스 — 아웃바운드 OAuth dance 오케스트레이션.
// start(authorizeUrl 생성 + 1회용 state) / callback(state 소비 → 토큰 교환 → 저장) / list / disconnect.
// HTTP 라우트와 MCP 도구가 같은 코어를 공유(BFF↔MCP 패리티). client_secret/토큰은 절대 브라우저로 안 나간다.
//
// provider 엔트리: stateless impl + selfHosted 여부 + (github.com 용) env 기본 자격증명.
//  - github.com (selfHosted=false): env 기본 OAuth App → 멤버 원클릭(입력 없음).
//  - GHE/Mattermost (selfHosted=true): **관리자가 워크스페이스 통합(Settings → 통합)에서 1회 등록**한
//    host + clientId(공개) + clientSecretName(SecretStore 키) 를 start/callback 에서 resolve →
//    멤버는 client ID 입력 없이 원클릭으로 연결한다(Linear 방식). client_secret 값은 SecretStore 에서 NAME 으로 resolve.
export interface ProviderEntry {
  impl: OAuthProvider;
  selfHosted: boolean;
  default?: { clientId: string; clientSecret: string }; // github.com env 기본(원클릭). self-hosted 는 없음.
}

// 멤버가 원클릭으로 연결 가능한 provider 디스크립터(GET /connections / list_connections).
export interface ProviderInfo {
  id: string;
  selfHosted: boolean;
}

// 관리자용 self-hosted 통합 디스크립터(GET /workspace/integrations / list_workspace_integrations).
// configured=true 면 host/clientId/clientSecretName 동봉(전부 비밀 아님 — client_secret 값은 절대 미반환).
export interface WorkspaceIntegrationInfo {
  id: string;
  selfHosted: true;
  configured: boolean;
  host?: string;
  clientId?: string;
  clientSecretName?: string;
}

export interface ConnectionServiceConfig {
  webBaseUrl: string; // 콜백 후 브라우저를 돌려보낼 웹 베이스(예: http://localhost:3001)
  apiPublicUrl?: string; // OAuth redirect_uri 베이스. 미설정이면 요청 base 로 폴백(dev 친화).
  stateTtlSec?: number; // pending state 만료(기본 600s)
}

export interface StartConnectionInput {
  workspace: string;
  createdBy: string;
  provider: string;
  requestBaseUrl?: string; // HTTP 라우트는 요청 base 제공. MCP 는 미제공 → config.apiPublicUrl 필요.
}

export class ConnectionService {
  private readonly store: ConnectionStore;
  private readonly states: OAuthStateStore;
  private readonly providers: Map<string, ProviderEntry>;
  private readonly secretsFor: (workspace: string) => Promise<Record<string, string>>;
  private readonly settings: WorkspaceSettingsStore; // self-hosted 통합 자격증명(워크스페이스-레벨, 관리자 설정)의 SSOT
  private readonly config: ConnectionServiceConfig;
  private readonly now: () => Date;
  constructor(deps: {
    store: ConnectionStore;
    states: OAuthStateStore;
    providers: Map<string, ProviderEntry>;
    secretsFor: (workspace: string) => Promise<Record<string, string>>;
    settings: WorkspaceSettingsStore;
    config: ConnectionServiceConfig;
    now?: () => Date;
  }) {
    this.store = deps.store;
    this.states = deps.states;
    this.providers = deps.providers;
    this.secretsFor = deps.secretsFor;
    this.settings = deps.settings;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  // 멤버가 원클릭으로 연결 가능한 provider — github.com 은 env 기본이 있을 때, self-hosted 는 **워크스페이스 통합이 설정된 경우에만**.
  // (관리자가 통합을 등록하지 않은 self-hosted provider 는 멤버에게 노출하지 않는다 — 연결할 수단이 없으므로.)
  async connectableProviders(workspace: string): Promise<ProviderInfo[]> {
    const integrations = (await this.settings.get(workspace))?.integrations ?? {};
    const out: ProviderInfo[] = [];
    for (const [id, entry] of this.providers) {
      if (entry.selfHosted) {
        if (integrations[id]) out.push({ id, selfHosted: true });
      } else if (entry.default) {
        out.push({ id, selfHosted: false });
      }
    }
    return out;
  }

  // 관리자용: self-hosted provider 카탈로그 + 현재 워크스페이스 통합 설정 머지(토큰/시크릿값 없음).
  async listIntegrations(workspace: string): Promise<WorkspaceIntegrationInfo[]> {
    const integrations = (await this.settings.get(workspace))?.integrations ?? {};
    const out: WorkspaceIntegrationInfo[] = [];
    for (const [id, entry] of this.providers) {
      if (!entry.selfHosted) continue;
      const cfg = integrations[id];
      out.push({
        id,
        selfHosted: true,
        configured: cfg !== undefined,
        ...(cfg ? { host: cfg.host, clientId: cfg.clientId, clientSecretName: cfg.clientSecretName } : {}),
      });
    }
    return out;
  }

  // 관리자용: self-hosted 통합 1건 등록/갱신(read-merge-write — 다른 provider 통합을 덮어쓰지 않는다).
  async setIntegration(
    workspace: string,
    provider: string,
    cfg: WorkspaceIntegrationConfig,
  ): Promise<WorkspaceIntegrationInfo[]> {
    const entry = this.providers.get(provider);
    if (!entry || !entry.selfHosted)
      throw new BadRequestError(
        "BAD_REQUEST",
        { provider },
        `워크스페이스 통합은 self-hosted provider 만 지원합니다: ${provider}`,
      );
    const current = (await this.settings.get(workspace))?.integrations ?? {};
    await this.settings.set(workspace, { integrations: { ...current, [provider]: cfg } });
    return this.listIntegrations(workspace);
  }

  // 관리자용: self-hosted 통합 1건 해제(기존 연결 토큰은 영향 없음 — 신규 연결만 막힌다).
  async removeIntegration(workspace: string, provider: string): Promise<WorkspaceIntegrationInfo[]> {
    const current = (await this.settings.get(workspace))?.integrations ?? {};
    if (current[provider] !== undefined) {
      const rest = Object.fromEntries(Object.entries(current).filter(([k]) => k !== provider));
      await this.settings.set(workspace, { integrations: rest });
    }
    return this.listIntegrations(workspace);
  }

  // OAuth 시작: 1회용 state 를 저장하고 provider authorize URL 을 만든다. 웹이 이 URL 로 브라우저를 보낸다.
  // 자격증명은 요청 바디가 아니라 (github.com=env / self-hosted=워크스페이스 통합 설정)에서 resolve — 멤버는 입력 없음.
  async start(input: StartConnectionInput): Promise<{ authorizeUrl: string }> {
    const entry = this.providers.get(input.provider);
    if (!entry)
      throw new BadRequestError(
        "BAD_REQUEST",
        { provider: input.provider },
        `지원하지 않거나 미설정된 provider 입니다: ${input.provider}`,
      );
    const redirectUri = this.redirectUri(input.requestBaseUrl); // 먼저 검증(orphan state 방지)
    const config = await this.resolveProviderConfig(entry, input.workspace, input.provider);
    const state = generateOAuthState();
    const expiresAt = new Date(this.now().getTime() + (this.config.stateTtlSec ?? 600) * 1000).toISOString();
    // pending 에는 자격증명을 싣지 않는다 — callback 이 workspace+provider 로 현재 통합 설정을 재해석한다.
    await this.states.put(
      state,
      { workspace: input.workspace, provider: input.provider, createdBy: input.createdBy },
      expiresAt,
    );
    return { authorizeUrl: entry.impl.authorizeUrl({ config, state, redirectUri }) };
  }

  // OAuth 콜백: state 1회 소비 → code 교환 → whoami → 저장. 항상 웹으로 돌려보낼 redirectTo(브라우저는 5xx 안 봄).
  async callback(input: {
    code?: string;
    state?: string;
    error?: string;
    requestBaseUrl?: string;
  }): Promise<{ redirectTo: string }> {
    if (!input.state) return { redirectTo: this.errorRedirect(undefined, "missing_state") };
    const pending = await this.states.take(input.state); // 1회용 — 만료/재사용은 null
    if (!pending) return { redirectTo: this.errorRedirect(undefined, "invalid_state") };
    if (input.error) return { redirectTo: this.errorRedirect(pending.workspace, input.error) };
    if (!input.code) return { redirectTo: this.errorRedirect(pending.workspace, "missing_code") };
    const entry = this.providers.get(pending.provider);
    if (!entry) return { redirectTo: this.errorRedirect(pending.workspace, "unknown_provider") };
    try {
      const config = await this.resolveProviderConfig(entry, pending.workspace, pending.provider);
      const redirectUri = this.redirectUri(input.requestBaseUrl);
      const tok = await entry.impl.exchange({ config, code: input.code, redirectUri });
      const account = await entry.impl.whoami({ config, accessToken: tok.accessToken });
      const create: CreateConnectionInput = {
        owner: pending.createdBy, // 개인 소유: 연결을 시작한 사람(subject)이 소유.
        workspace: pending.workspace, // 만들어진 워크스페이스 — 로스터(listForWorkspace) + redirect/통합 resolve 용.
        provider: pending.provider,
        accountLabel: account.label,
        scopes: tok.scopes,
        accessToken: tok.accessToken,
        ...(config.host !== undefined ? { host: config.host } : {}), // self-hosted host(통합 설정에서)
        ...(tok.refreshToken !== undefined ? { refreshToken: tok.refreshToken } : {}),
        ...(tok.expiresAt !== undefined ? { expiresAt: tok.expiresAt } : {}),
      };
      await this.store.create(create);
      return { redirectTo: this.successRedirect(pending.workspace, pending.provider) };
    } catch {
      // 토큰 교환/whoami/자격증명 resolve 실패 — 브라우저엔 웹 에러 콜아웃으로(원시 에러 노출 금지).
      return { redirectTo: this.errorRedirect(pending.workspace, "exchange_failed") };
    }
  }

  // 개인 소유: owner=principal.subject 로 조회/해제(워크스페이스 무관 — 어느 워크스페이스에서도 내 연결을 본다).
  async list(owner: string): Promise<ConnectionMeta[]> {
    return this.store.list(owner);
  }
  async disconnect(owner: string, id: string): Promise<void> {
    await this.store.remove(owner, id);
  }
  // 워크스페이스 애플리케이션 로스터(읽기 전용) — 이 워크스페이스에서 만들어진 연결들의 메타(토큰 없음). settings>멤버 탭용.
  async listForWorkspace(workspace: string): Promise<ConnectionMeta[]> {
    return this.store.listByWorkspace(workspace);
  }

  // provider 자격증명 resolve — github.com 은 env 기본, self-hosted 는 워크스페이스 통합 설정(관리자 1회 등록).
  // start/callback 공용: secret 값은 매번 SecretStore 에서 NAME 으로 다시 resolve(값을 state/연결에 저장하지 않는다).
  private async resolveProviderConfig(
    entry: ProviderEntry,
    workspace: string,
    provider: string,
  ): Promise<OAuthProviderConfig> {
    if (!entry.selfHosted) {
      if (!entry.default) throw new BadRequestError("BAD_REQUEST", { provider }, `provider 미설정: ${provider}`);
      return { clientId: entry.default.clientId, clientSecret: entry.default.clientSecret };
    }
    const integration = (await this.settings.get(workspace))?.integrations?.[provider];
    if (!integration)
      throw new BadRequestError(
        "BAD_REQUEST",
        { provider },
        `이 워크스페이스에 '${provider}' 통합이 설정되지 않았습니다(관리자가 Settings → 통합에서 등록해야 합니다).`,
      );
    const clientSecret = await this.resolveSecret(workspace, integration.clientSecretName);
    return { clientId: integration.clientId, clientSecret, host: integration.host };
  }

  private async resolveSecret(workspace: string, name: string): Promise<string> {
    const value = (await this.secretsFor(workspace))[name];
    if (!value)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name },
        `SecretStore 에 '${name}' 시크릿이 없습니다(OAuth client_secret 을 먼저 등록하세요).`,
      );
    return value;
  }

  // 관리자가 provider OAuth 앱에 등록해야 하는 콜백(redirect) URL. 결정 불가(apiPublicUrl 미설정 + base 모름)면 undefined.
  // 통합 설정 화면에서 admin 에게 보여주기 위함(어떤 URL 을 OAuth 앱에 넣어야 하는지 명확히).
  callbackUrl(requestBaseUrl?: string): string | undefined {
    const base = this.config.apiPublicUrl ?? requestBaseUrl;
    return base ? `${trimSlash(base)}/connections/callback` : undefined;
  }

  private redirectUri(requestBaseUrl?: string): string {
    const url = this.callbackUrl(requestBaseUrl);
    if (!url)
      throw new BadRequestError(
        "BAD_REQUEST",
        {},
        "API_PUBLIC_URL 미설정 — OAuth redirect_uri 베이스를 결정할 수 없습니다.",
      );
    return url;
  }
  // 연결은 개인 소유 → 콜백 복귀 위치는 워크스페이스 설정이 아닌 개인 계정 페이지(/<workspace>/account).
  // URL 은 여전히 워크스페이스-스코프(pending.workspace) — 활성 워크스페이스 컨텍스트를 유지하기 위함.
  private accountUrl(workspace: string): string {
    return `${trimSlash(this.config.webBaseUrl)}/${encodeURIComponent(workspace)}/account?tab=connections`;
  }
  private successRedirect(workspace: string, provider: string): string {
    return `${this.accountUrl(workspace)}&connected=${encodeURIComponent(provider)}`;
  }
  private errorRedirect(workspace: string | undefined, reason: string): string {
    if (workspace === undefined)
      return `${trimSlash(this.config.webBaseUrl)}/?connection_error=${encodeURIComponent(reason)}`;
    return `${this.accountUrl(workspace)}&error=${encodeURIComponent(reason)}`;
  }
}

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
