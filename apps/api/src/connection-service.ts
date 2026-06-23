import { BadRequestError } from "@assay/core";
import {
  type ConnectionMeta,
  type ConnectionStore,
  type CreateConnectionInput,
  type OAuthStatePending,
  type OAuthStateStore,
  generateOAuthState,
} from "@assay/db";
import type { OAuthProvider, OAuthProviderConfig } from "./oauth/provider.js";

// 외부 계정 연결(Connected accounts) 서비스 — 아웃바운드 OAuth dance 오케스트레이션.
// start(authorizeUrl 생성 + 1회용 state) / callback(state 소비 → 토큰 교환 → 저장) / list / disconnect.
// HTTP 라우트와 MCP 도구가 같은 코어를 공유(BFF↔MCP 패리티). client_secret/토큰은 절대 브라우저로 안 나간다.
//
// provider 엔트리: stateless impl + selfHosted 여부 + (github.com 용) env 기본 자격증명.
//  - github.com (selfHosted=false): env 기본 OAuth App → 원클릭(입력 없음).
//  - GHE/Mattermost (selfHosted=true): connect 시 host + clientId(공개) + clientSecretName(SecretStore 키) 입력 →
//    client_secret 값은 SecretStore 에서 NAME 으로 resolve(값은 state 에 저장하지 않는다).
export interface ProviderEntry {
  impl: OAuthProvider;
  selfHosted: boolean;
  default?: { clientId: string; clientSecret: string }; // github.com env 기본(원클릭). self-hosted 는 없음.
}

export interface ProviderInfo {
  id: string;
  selfHosted: boolean;
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
  host?: string; // self-hosted
  clientId?: string; // self-hosted OAuth app client_id(공개값)
  clientSecretName?: string; // self-hosted client_secret 의 SecretStore 키 이름
  requestBaseUrl?: string; // HTTP 라우트는 요청 base 제공. MCP 는 미제공 → config.apiPublicUrl 필요.
}

export class ConnectionService {
  private readonly store: ConnectionStore;
  private readonly states: OAuthStateStore;
  private readonly providers: Map<string, ProviderEntry>;
  private readonly secretsFor: (workspace: string) => Promise<Record<string, string>>;
  private readonly config: ConnectionServiceConfig;
  private readonly now: () => Date;
  constructor(deps: {
    store: ConnectionStore;
    states: OAuthStateStore;
    providers: Map<string, ProviderEntry>;
    secretsFor: (workspace: string) => Promise<Record<string, string>>;
    config: ConnectionServiceConfig;
    now?: () => Date;
  }) {
    this.store = deps.store;
    this.states = deps.states;
    this.providers = deps.providers;
    this.secretsFor = deps.secretsFor;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  // 연결 가능한 provider 디스크립터 — 웹이 원클릭(github.com) vs self-hosted 폼(GHE/Mattermost)을 구분.
  // github.com 은 env 기본이 있을 때만, self-hosted 는 항상 노출(connect 시 host+자격증명 입력).
  providerInfos(): ProviderInfo[] {
    const out: ProviderInfo[] = [];
    for (const [id, entry] of this.providers) {
      if (entry.selfHosted || entry.default) out.push({ id, selfHosted: entry.selfHosted });
    }
    return out;
  }

  // OAuth 시작: 1회용 state 를 저장하고 provider authorize URL 을 만든다. 웹이 이 URL 로 브라우저를 보낸다.
  async start(input: StartConnectionInput): Promise<{ authorizeUrl: string }> {
    const entry = this.providers.get(input.provider);
    if (!entry)
      throw new BadRequestError(
        "BAD_REQUEST",
        { provider: input.provider, available: this.providerInfos().map((p) => p.id) },
        `지원하지 않거나 미설정된 provider 입니다: ${input.provider}`,
      );
    const redirectUri = this.redirectUri(input.requestBaseUrl); // 먼저 검증(orphan state 방지)
    const { config, persist } = await this.resolveStartConfig(entry, input);
    const state = generateOAuthState();
    const expiresAt = new Date(this.now().getTime() + (this.config.stateTtlSec ?? 600) * 1000).toISOString();
    await this.states.put(
      state,
      { workspace: input.workspace, provider: input.provider, createdBy: input.createdBy, ...persist },
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
      const config = await this.resolveCallbackConfig(entry, pending);
      const redirectUri = this.redirectUri(input.requestBaseUrl);
      const tok = await entry.impl.exchange({ config, code: input.code, redirectUri });
      const account = await entry.impl.whoami({ config, accessToken: tok.accessToken });
      const create: CreateConnectionInput = {
        owner: pending.createdBy, // 개인 소유: 연결을 시작한 사람(subject)이 소유.
        workspace: pending.workspace, // 만들어진 워크스페이스 — 로스터(listForWorkspace) + redirect/secret 용.
        provider: pending.provider,
        accountLabel: account.label,
        scopes: tok.scopes,
        accessToken: tok.accessToken,
        ...(pending.host !== undefined ? { host: pending.host } : {}),
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

  // start: self-hosted 는 host+clientId+clientSecretName 요구 + SecretStore 에서 secret 값 resolve.
  // github.com 은 env 기본 자격증명(입력 없음).
  private async resolveStartConfig(
    entry: ProviderEntry,
    input: StartConnectionInput,
  ): Promise<{ config: OAuthProviderConfig; persist: Partial<OAuthStatePending> }> {
    if (entry.selfHosted) {
      if (!input.host || !input.clientId || !input.clientSecretName)
        throw new BadRequestError(
          "BAD_REQUEST",
          { provider: input.provider },
          "self-hosted provider 는 host + clientId + clientSecretName 이 필요합니다.",
        );
      const clientSecret = await this.resolveSecret(input.workspace, input.clientSecretName);
      return {
        config: { clientId: input.clientId, clientSecret, host: input.host },
        persist: { host: input.host, clientId: input.clientId, clientSecretName: input.clientSecretName },
      };
    }
    if (!entry.default)
      throw new BadRequestError("BAD_REQUEST", { provider: input.provider }, `provider 미설정: ${input.provider}`);
    return { config: { clientId: entry.default.clientId, clientSecret: entry.default.clientSecret }, persist: {} };
  }

  // callback: start 에서 보존한 host/clientId/clientSecretName 으로 자격증명 재해석(secret 값은 다시 SecretStore 에서).
  private async resolveCallbackConfig(entry: ProviderEntry, pending: OAuthStatePending): Promise<OAuthProviderConfig> {
    if (entry.selfHosted) {
      if (!pending.host || !pending.clientId || !pending.clientSecretName)
        throw new BadRequestError(
          "BAD_REQUEST",
          { provider: pending.provider },
          "self-hosted 연결 컨텍스트가 불완전합니다.",
        );
      const clientSecret = await this.resolveSecret(pending.workspace, pending.clientSecretName);
      return { clientId: pending.clientId, clientSecret, host: pending.host };
    }
    if (!entry.default)
      throw new BadRequestError("BAD_REQUEST", { provider: pending.provider }, `provider 미설정: ${pending.provider}`);
    return { clientId: entry.default.clientId, clientSecret: entry.default.clientSecret };
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

  private redirectUri(requestBaseUrl?: string): string {
    const base = this.config.apiPublicUrl ?? requestBaseUrl;
    if (!base)
      throw new BadRequestError(
        "BAD_REQUEST",
        {},
        "API_PUBLIC_URL 미설정 — OAuth redirect_uri 베이스를 결정할 수 없습니다.",
      );
    return `${trimSlash(base)}/connections/callback`;
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
