import { BadRequestError, NotFoundError } from "@assay/core";
import {
  type OAuthStateStore,
  type WorkspaceSettings,
  type WorkspaceSettingsStore,
  generateOAuthState,
} from "@assay/db";
import { z } from "zod";
import { getInstallation, mintInstallationToken } from "./oauth/github-app.js";
import { oauthFetchJson } from "./oauth/provider.js";

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

// GitHub API 베이스 — github.com 은 api.github.com, GHE 는 host/api/v3. installation.host 로 판별.
function apiBase(host?: string): string {
  return host ? `${trimSlash(host)}/api/v3` : "https://api.github.com";
}
// installation 토큰으로 GitHub API 호출 헤더.
function appTokenHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "assay",
    "content-type": "application/json",
  };
}

// picker 한 행 — installation 이 접근 가능한 repo(GET /installation/repositories)를 얇게 정규화.
export interface InstallationRepo {
  fullName: string; // "owner/name"
  private: boolean;
  defaultBranch: string;
  pushedAt?: string;
}
const InstallationReposResponse = z.object({
  repositories: z.array(
    z.object({
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string(),
      pushed_at: z.string().nullable().optional(),
    }),
  ),
});
const RunnerTokenResponse = z.object({ token: z.string(), expires_at: z.string() });

// git URL → { host?, owner, repo }. github.com 은 host 생략(=env App), 그 외는 GHE 베이스로 취급.
function parseGitRepo(gitUrl: string): { host?: string; owner: string; repo: string } | undefined {
  let u: URL;
  try {
    u = new URL(gitUrl);
  } catch {
    return undefined;
  }
  const parts = u.pathname
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return undefined;
  const host = u.hostname === "github.com" ? undefined : `${u.protocol}//${u.host}`;
  return host ? { host, owner, repo } : { owner, repo };
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

  // 비공개 repo clone 토큰 — git URL 의 owner 가 워크스페이스 installation account 와 매칭되면 그 App 으로
  // 그 repo 에 한정한 단기(~1h) installation 토큰을 발급(contents:read). 매칭 installation 없으면 undefined.
  // 실행(execute-case)이 dispatch 시각에 부르고, 반환 토큰은 transient(AgentJob.repoToken)로만 실린다(저장 안 함).
  async tokenForRepo(workspace: string, gitUrl: string): Promise<string | undefined> {
    const parsed = parseGitRepo(gitUrl);
    if (!parsed) return undefined;
    const install = await this.installationForOwner(workspace, parsed.owner);
    if (!install) return undefined;
    return this.mintFor(workspace, install, { repositories: [parsed.repo], permissions: { contents: "read" } });
  }

  // picker — 워크스페이스 installation(들)이 접근 가능한 repo 목록(개인 연결 대체). 각 installation 의
  // GET /installation/repositories 를 합친다. 설치 시 고른 repo 만 나온다(=팀이 명시 허용한 것만).
  async listRepos(workspace: string): Promise<InstallationRepo[]> {
    const g = (await this.settings.get(workspace))?.githubApp;
    const out: InstallationRepo[] = [];
    for (const install of g?.installations ?? []) {
      const token = await this.mintFor(workspace, install, {}); // 제한 없음 → 설치된 repo 전부 조회
      const body = await oauthFetchJson(`${apiBase(install.host)}/installation/repositories?per_page=100`, {
        headers: appTokenHeaders(token),
      });
      for (const r of InstallationReposResponse.parse(body).repositories)
        out.push({
          fullName: r.full_name,
          private: r.private,
          defaultBranch: r.default_branch,
          ...(r.pushed_at ? { pushedAt: r.pushed_at } : {}),
        });
    }
    return out;
  }

  // "owner/name" repo 에 대한 installation 토큰(지정 권한) + host. setup-PR 등 쓰기 작업용(예: contents/pull_requests write).
  // 매칭 installation 없으면 NotFound(개인 연결과 달리 워크스페이스가 그 org 에 App 을 설치해야 함).
  async tokenForRepository(
    workspace: string,
    repository: string,
    permissions: Record<string, string>,
  ): Promise<{ token: string; host?: string }> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo)
      throw new BadRequestError("BAD_REQUEST", { repository }, `repository 는 "owner/name" 형식이어야 합니다.`);
    const install = await this.installationForOwner(workspace, owner);
    if (!install)
      throw new NotFoundError(
        "NOT_FOUND",
        { repository },
        `'${repository}' 에 설치된 워크스페이스 GitHub App 이 없습니다.`,
      );
    const token = await this.mintFor(workspace, install, { repositories: [repo], permissions });
    return { token, ...(install.host ? { host: install.host } : {}) };
  }

  // GitHub Actions 셀프호스티드 러너 등록 토큰 — 워크스페이스 App installation(administration:write)으로 그 대상(repo|org)에 대해 mint.
  // 단기 토큰(≈1h). 개인 연결/admin:org 스코프 대신, App 이 그 org/repo 에 설치돼 있고 administration 권한을 가지면 발급된다.
  async runnerRegistrationToken(
    workspace: string,
    target: { repo: string } | { org: string },
  ): Promise<{ token: string; expiresAt: string; host?: string }> {
    const owner = "repo" in target ? (target.repo.split("/")[0] ?? "") : target.org;
    const install = await this.installationForOwner(workspace, owner);
    if (!install)
      throw new NotFoundError("NOT_FOUND", { owner }, `'${owner}' 에 설치된 워크스페이스 GitHub App 이 없습니다.`);
    const appToken = await this.mintFor(workspace, install, { permissions: { administration: "write" } });
    const path = "repo" in target ? `/repos/${target.repo}` : `/orgs/${target.org}`;
    const body = await oauthFetchJson(`${apiBase(install.host)}${path}/actions/runners/registration-token`, {
      method: "POST",
      headers: appTokenHeaders(appToken),
    });
    const data = RunnerTokenResponse.parse(body);
    return { token: data.token, expiresAt: data.expires_at, ...(install.host ? { host: install.host } : {}) };
  }

  // owner(org/user login) 로 워크스페이스 installation 을 찾는다(org 는 한 GitHub 호스트에 유일 → host 무시).
  private async installationForOwner(workspace: string, owner: string): Promise<Installation | undefined> {
    const g = (await this.settings.get(workspace))?.githubApp;
    return g?.installations.find((i) => i.account.toLowerCase() === owner.toLowerCase());
  }

  // 한 installation 에 대해 installation 토큰 발급(repositories/permissions 로 좁힘). 자격증명은 env(github.com) 또는 GHE 등록.
  private async mintFor(
    workspace: string,
    install: Installation,
    opts: { repositories?: string[]; permissions?: Record<string, string> },
  ): Promise<string> {
    const creds = await this.resolveAppCreds(workspace, install.host);
    const tok = await mintInstallationToken({
      ...(install.host ? { host: install.host } : {}),
      appId: creds.appId,
      privateKeyPem: creds.privateKeyPem,
      installationId: install.installationId,
      ...(opts.repositories ? { repositories: opts.repositories } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      nowSec: this.nowSec(),
    });
    return tok.token;
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
