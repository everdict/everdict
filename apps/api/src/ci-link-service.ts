import { BadRequestError, NotFoundError, UpstreamError } from "@assay/core";
import type { WorkspaceCiLink, WorkspaceSettingsStore } from "@assay/db";
import { z } from "zod";

// CI repo link 서비스 — repository ↔ 하니스 서비스 슬롯 매핑(= GitHub Actions OIDC trust policy) CRUD +
// 멤버 개인 GitHub 연결로 레포 목록 프록시(picker) + setup-PR 생성기(워크플로 YAML 을 대상 레포에 PR).
// "별다른 입력 없이": picker 에서 레포 선택 → link 저장 → setup-PR 버튼 → 머지 — 사용자는 YAML/키를 만지지 않는다.
// 설계: docs/architecture/github-actions-trigger.md (D3). HTTP 라우트와 MCP 도구가 같은 코어를 공유(BFF↔MCP 패리티).

export const UpsertCiLinkBodySchema = z.object({
  repository: z.string().min(1), // "owner/name"
  host: z.string().url().optional(), // GHE 베이스 URL(예: "https://ghe.acme.io") — 미지정 = github.com
  harness: z.string().min(1), // 하니스 인스턴스 id
  dataset: z.string().optional(), // 발사할 데이터셋 id — setup-PR 워크플로 생성에 필요(없으면 YAML 에 TODO)
  slots: z.record(z.object({ path: z.string().optional() })).default({}), // 서비스 슬롯 → 모노레포 path(선택)
  runsOn: z.string().min(1).optional(), // 좁히기 오버라이드 — 워크플로 runs-on(기본 "[self-hosted]", 예: "[self-hosted, assay-<id>]")
  runtime: z.string().min(1).optional(), // 좁히기 오버라이드 — run-eval runtime(기본 "self:ws" 풀, 예: "self:ws:<id>")
  trigger: z.enum(["auto", "comment", "both"]).optional(), // PR 평가 발화 방식(미지정=both) — WorkspaceCiLinkSchema 참고
});
export type UpsertCiLinkBody = z.infer<typeof UpsertCiLinkBodySchema>;

// picker 한 행 — GitHub API 응답을 얇게 정규화(무거운 원본 미노출).
export interface RepoInfo {
  fullName: string; // "owner/name"
  host?: string; // 이 repo 가 속한 installation 의 GHE 베이스 URL — 미지정 = github.com
  private: boolean;
  defaultBranch: string;
  pushedAt?: string;
}

// picker/setup-PR/러너 등록이 필요로 하는 워크스페이스 GitHub App 능력(개인 연결 대체). GithubAppService 가 구조적으로 만족.
export interface GithubAppRepoAccess {
  listRepos(workspace: string): Promise<RepoInfo[]>;
  tokenForRepository(
    workspace: string,
    repository: string,
    permissions: Record<string, string>,
    host?: string, // 미지정 = github.com — link 의 host 로 정확한 installation 을 고른다
  ): Promise<{ token: string; host?: string }>;
  runnerRegistrationToken(
    workspace: string,
    target: { repo: string } | { org: string },
  ): Promise<{ token: string; expiresAt: string; host?: string }>;
}

// 워크스페이스-공유 러너 로스터(존재 확인용) — RunnerService 가 구조적으로 만족. CI 배치는 항상 셀프호스티드(설계 D6)라
// setup-PR 이 기본 self:ws 풀의 러너 유무를 fail-closed 로 검사한다(러너 0대인 채 머지된 워크플로는 GitHub 큐에서
// 조용히 대기 — 가장 늦고 가장 헷갈리는 실패 지점이므로 PR 을 열기 전에 막는다).
export interface WorkspaceRunnerRoster {
  listWorkspaceOwned(workspace: string): Promise<{ id: string }[]>;
}

export interface CiLinkServiceDeps {
  settings: WorkspaceSettingsStore;
  githubApp: GithubAppRepoAccess; // 워크스페이스 소유 GitHub App — repos picker + setup-PR 커밋/PR + 러너 등록 토큰
  runners: WorkspaceRunnerRoster; // 워크스페이스-공유 러너 로스터 — setup-PR 의 self:ws 풀 존재 검사
  apiPublicUrl?: string; // 생성 워크플로의 api-url 값(미설정이면 요청 base 폴백)
  fetchImpl?: typeof fetch; // 테스트 주입
}

// GitHub API 베이스 — github.com 은 api. 서브도메인, GHE 는 /api/v3 (연결의 host 로 판별).
function apiBase(host?: string): string {
  return host ? `${host.replace(/\/$/, "")}/api/v3` : "https://api.github.com";
}

// link 동일성 키 = (host, repository) — 같은 "owner/name" 이 github.com 과 GHE 양쪽에 있을 수 있다.
// host 비교는 트레일링 슬래시/대소문자 무시, undefined = github.com.
function sameLinkKey(link: { repository: string; host?: string }, repository: string, host?: string): boolean {
  const norm = (h?: string): string | undefined => h?.replace(/\/$/, "").toLowerCase();
  return link.repository.toLowerCase() === repository.toLowerCase() && norm(link.host) === norm(host);
}

export class CiLinkService {
  private readonly fetch: typeof fetch;
  constructor(private readonly deps: CiLinkServiceDeps) {
    this.fetch = deps.fetchImpl ?? fetch;
  }

  async list(workspace: string): Promise<WorkspaceCiLink[]> {
    return (await this.deps.settings.get(workspace))?.ci?.links ?? [];
  }

  // upsert — (host, repository) 키(대소문자 무시)당 1건. link 의 존재가 그 레포의 OIDC trust 이므로 생성=신뢰 부여(admin 게이트는 라우트).
  async upsert(workspace: string, subject: string, body: UpsertCiLinkBody): Promise<WorkspaceCiLink[]> {
    // CI 는 개인 러너를 리스할 수 없다(dispatcher 의 self/self:<id> 는 owner=제출자 — via:"github-actions" principal 은
    // 멤버 개인 러너의 owner 가 아니다). 개인 self 계열 runtime 은 발사 시점에만 터지므로 링크 저장에서 미리 막는다.
    const rt = body.runtime;
    if (rt === "self" || (rt?.startsWith("self:") === true && rt !== "self:ws" && !rt.startsWith("self:ws:")))
      throw new BadRequestError(
        "BAD_REQUEST",
        { runtime: rt },
        `CI 는 개인 러너(runtime '${rt}')를 쓸 수 없습니다 — 워크스페이스 공유 러너("self:ws" 풀 또는 "self:ws:<id>")를 지정하세요.`,
      );
    const current = await this.list(workspace);
    const next: WorkspaceCiLink = {
      repository: body.repository,
      harness: body.harness,
      slots: body.slots,
      createdBy: subject,
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.dataset !== undefined ? { dataset: body.dataset } : {}),
      ...(body.runsOn !== undefined ? { runsOn: body.runsOn } : {}),
      ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
    };
    const rest = current.filter((l) => !sameLinkKey(l, body.repository, body.host));
    await this.deps.settings.set(workspace, { ci: { links: [...rest, next] } });
    return this.list(workspace);
  }

  async remove(workspace: string, repository: string, host?: string): Promise<WorkspaceCiLink[]> {
    const current = await this.list(workspace);
    const rest = current.filter((l) => !sameLinkKey(l, repository, host));
    if (rest.length !== current.length) await this.deps.settings.set(workspace, { ci: { links: rest } });
    return this.list(workspace);
  }

  // picker — 워크스페이스 GitHub App installation 이 접근 가능한 레포 목록(설치 시 고른 것만). 토큰은 서버 안에서만.
  async listRepos(workspace: string): Promise<RepoInfo[]> {
    return this.deps.githubApp.listRepos(workspace);
  }

  // setup-PR — link 로부터 워크플로 YAML 을 합성해 대상 레포에 브랜치+커밋+PR 을 연다(워크스페이스 App 토큰).
  // 멱등에 가깝게: 브랜치/PR 이 이미 있으면 재사용/기존 PR 반환. 머지 여부는 GitHub 쪽 사람의 결정.
  async openSetupPr(
    workspace: string,
    repository: string,
    opts: { host?: string; requestBaseUrl?: string } = {},
  ): Promise<{ prUrl: string; branch: string }> {
    const link = (await this.list(workspace)).find((l) => sameLinkKey(l, repository, opts.host) && !l.disabled);
    if (!link) throw new NotFoundError("NOT_FOUND", { repository }, `'${repository}' 의 repo link 가 없습니다.`);
    // 배치는 항상 셀프호스티드(설계 D6) — 워크플로가 self:ws 풀을 타깃하면 러너가 실제로 등록돼 있어야 한다.
    // 러너 0대로 머지된 워크플로는 GitHub 큐에서 조용히 대기하므로, PR 을 열기 전(가장 이른 관측 지점)에 fail-closed.
    const runtime = link.runtime ?? "self:ws";
    if (runtime === "self:ws" || runtime.startsWith("self:ws:")) {
      const roster = await this.deps.runners.listWorkspaceOwned(workspace);
      if (roster.length === 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { repository },
          "워크스페이스 공유 러너가 없습니다 — CI 워크플로는 셀프호스티드 러너에서 실행됩니다. 설정 › 공유 러너의 'GitHub Actions 러너'(POST /workspace/runners/github-install)로 빌드 서버를 먼저 등록하세요.",
        );
      const runnerId = runtime.startsWith("self:ws:") ? runtime.slice("self:ws:".length) : undefined;
      if (runnerId !== undefined && !roster.some((r) => r.id === runnerId))
        throw new NotFoundError(
          "NOT_FOUND",
          { runtime },
          `link 의 runtime '${runtime}' 에 해당하는 공유 러너가 없습니다 — 러너를 다시 등록하거나 runtime 을 비워("self:ws" 풀) 두세요.`,
        );
    }
    // 워크스페이스 App installation 토큰(쓰기) — 브랜치/파일/PR 을 만들려면 contents + pull_requests write.
    // link.host 로 installation 을 고른다(같은 org 명이 github.com/GHE 양쪽에 있어도 정확히).
    const { token, host } = await this.deps.githubApp.tokenForRepository(
      workspace,
      link.repository,
      { contents: "write", pull_requests: "write" },
      link.host,
    );
    const base = apiBase(host);
    const apiUrl = this.deps.apiPublicUrl ?? opts.requestBaseUrl;
    if (!apiUrl)
      throw new BadRequestError("BAD_REQUEST", {}, "API_PUBLIC_URL 미설정 — 워크플로의 api-url 을 결정할 수 없습니다.");
    const yaml = renderCiWorkflow(link, workspace, apiUrl.replace(/\/$/, ""));
    const branch = "assay/eval-setup";
    const path = ".github/workflows/assay-eval.yml";

    const repo = z
      .object({ default_branch: z.string() })
      .parse(await (await this.gh(`${base}/repos/${link.repository}`, token)).json());
    const head = z
      .object({ object: z.object({ sha: z.string() }) })
      .parse(
        await (await this.gh(`${base}/repos/${link.repository}/git/ref/heads/${repo.default_branch}`, token)).json(),
      );

    // 브랜치 생성(이미 있으면 재사용 — 422 Reference already exists).
    const mkRef = await this.fetch(`${base}/repos/${link.repository}/git/refs`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }),
    });
    if (!mkRef.ok && mkRef.status !== 422) throw await this.upstream(mkRef, "브랜치 생성 실패");

    // 파일 커밋 — 기존 파일이 있으면 sha 필요(update). 404 면 신규.
    const existing = await this.fetch(`${base}/repos/${link.repository}/contents/${path}?ref=${branch}`, {
      headers: this.headers(token),
    });
    const existingSha = existing.ok ? z.object({ sha: z.string() }).parse(await existing.json()).sha : undefined;
    const put = await this.fetch(`${base}/repos/${link.repository}/contents/${path}`, {
      method: "PUT",
      headers: this.headers(token),
      body: JSON.stringify({
        message: "ci: add Assay eval workflow",
        content: Buffer.from(yaml, "utf8").toString("base64"),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    if (!put.ok) throw await this.upstream(put, "워크플로 파일 커밋 실패");

    // PR 생성 — 이미 열려 있으면(422) 기존 PR 을 찾아 반환.
    const mkPr = await this.fetch(`${base}/repos/${link.repository}/pulls`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({
        title: "Assay eval 워크플로 추가",
        head: branch,
        base: repo.default_branch,
        body: `Assay 가 생성한 CI eval 셋업입니다. 머지하면 PR/머지마다 \`${link.harness}\` 평가가 발사됩니다.\n\n- workspace: \`${workspace}\`\n- 인증: GitHub OIDC 페더레이션(keyless — repo link 가 신뢰를 부여)`,
      }),
    });
    if (mkPr.ok) {
      const pr = z.object({ html_url: z.string() }).parse(await mkPr.json());
      return { prUrl: pr.html_url, branch };
    }
    if (mkPr.status === 422) {
      const list = await this.gh(
        `${base}/repos/${link.repository}/pulls?head=${encodeURIComponent(`${link.repository.split("/")[0]}:${branch}`)}&state=open`,
        token,
      );
      const prs = z.array(z.object({ html_url: z.string() })).parse(await list.json());
      const first = prs[0];
      if (first) return { prUrl: first.html_url, branch };
    }
    throw await this.upstream(mkPr, "PR 생성 실패");
  }

  // GitHub Actions 셀프호스티드 러너 등록 토큰 발급 — 워크스페이스 GitHub App(administration)으로 대상(repo|org)에 mint.
  // 단기 토큰(≈1시간). Assay 는 장기 러너 토큰을 저장하지 않는다(필요 시마다 발급). App 이 그 org/repo 에 설치돼 있어야 한다.
  async mintRunnerToken(
    workspace: string,
    target: { repo: string } | { org: string },
  ): Promise<{ token: string; expiresAt: string; host?: string }> {
    return this.deps.githubApp.runnerRegistrationToken(workspace, target);
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "assay-control-plane",
    };
  }

  // GET 계열 공통 — 비-2xx 는 UpstreamError 로 remap(원시 GitHub 에러를 그대로 흘리지 않는다).
  private async gh(url: string, token: string): Promise<Response> {
    const res = await this.fetch(url, { headers: this.headers(token) });
    if (!res.ok) throw await this.upstream(res, "GitHub API 호출 실패");
    return res;
  }

  private async upstream(res: Response, prefix: string): Promise<UpstreamError> {
    const text = await res.text().catch(() => "");
    return new UpstreamError(
      "UPSTREAM_ERROR",
      { status: res.status },
      `${prefix} (GitHub ${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

// link.host → CI 빌드가 push 할 컨테이너 레지스트리. github.com 은 GHCR, GHE 는 그 인스턴스의
// 컨테이너 레지스트리(containers.<hostname> — 서브도메인 격리). GHES 의 `GITHUB_TOKEN` 은 ghcr.io 에
// 로그인할 수 없으므로 GHE link 에 ghcr.io 를 내보내면 워크플로가 반드시 실패한다.
function registryFor(host?: string): string {
  if (!host) return "ghcr.io";
  try {
    return `containers.${new URL(host).hostname}`;
  } catch {
    throw new BadRequestError("BAD_REQUEST", { host }, `link 의 host 가 URL 이 아닙니다: ${host}`);
  }
}

// link → 워크플로 YAML 합성 — 사용자는 YAML 을 만지지 않는다(zero-input 의 핵심).
// PR/push/PR-코멘트(/evaluate) 겸용 한 파일: 슬롯별 이미지 빌드(레지스트리는 link.host 에 따라 GHCR/GHE, digest 출력) →
// assay run-eval 액션(모드 자동, OIDC keyless — GHES issuer 도 컨트롤플레인이 신뢰).
// trigger 노브: auto=PR 이벤트 자동만 · comment=/evaluate 코멘트만(비싼 스위트 온디맨드) · both(기본)=둘 다.
// push(기본 브랜치 재핀)는 항상. issue_comment 의 함정 3개를 이 템플릿이 흡수한다(사용자 YAML 지식 불요):
//  ① 기본 브랜치 컨텍스트로 돌므로 PR head 를 명시 체크아웃(refs/pull/N/head)하고 sha 는 git 으로 해석,
//  ② concurrency 그룹을 PR 번호로 묶어 코멘트 발화 ↔ 같은 PR 의 자동 발화가 서로 supersede,
//  ③ 코멘트 발화는 PR 체크가 안 달리므로(기본 브랜치 런) 대화 코멘트가 유일한 피드백 — 쓰기 권한+토큰을 내려준다.
// 모노레포 최적화(path filter 로 바뀐 슬롯만 빌드)는 후속 — v1 은 링크된 슬롯 전부 빌드(정확성 우선).
export function renderCiWorkflow(link: WorkspaceCiLink, workspace: string, apiUrl: string): string {
  const registry = registryFor(link.host);
  const slots = Object.entries(link.slots);
  const buildSteps = slots
    .map(([slot, cfg]) =>
      [
        `      - name: Build ${slot}`,
        `        id: build-${slot}`,
        "        uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${cfg.path ?? "."}`,
        "          push: true",
        `          tags: ${registry}/\${{ github.repository }}/${slot}:\${{ steps.head.outputs.sha }}`,
      ].join("\n"),
    )
    .join("\n");
  const imagesJson = `{${slots
    .map(
      ([slot]) =>
        `"${slot}":"${registry}/\${{ github.repository }}/${slot}@\${{ steps.build-${slot}.outputs.digest }}"`,
    )
    .join(",")}}`;
  // 배치는 항상 셀프호스티드(설계 D6) — 컨트롤플레인이 사설망이어도 CI(run-eval)가 도달해야 하므로 GitHub-호스티드
  // 러너 경로는 없다. 기본: 레포에 등록된 아무 셀프호스티드 러너([self-hosted]) + 워크스페이스 러너 풀(self:ws).
  // link.runsOn/runtime 은 특정 라벨/러너·관리형 런타임으로 좁히는 오버라이드다.
  const runsOn = link.runsOn ?? "[self-hosted]";
  const runtimeLine = `\n          runtime: ${link.runtime ?? "self:ws"}`;
  const trigger = link.trigger ?? "both";
  const onBlock = [
    ...(trigger !== "comment" ? ["  pull_request:"] : []),
    ...(trigger !== "auto" ? ["  issue_comment:", "    types: [created]"] : []),
    "  push:",
    "    branches: [main]",
  ].join("\n");
  // 코멘트 발화 피드백(👀 리액션 + 결과 코멘트)용 쓰기 권한/토큰 — 코멘트 트리거가 없으면 부여하지 않는다(최소 권한).
  const commentPermissions = trigger !== "auto" ? "\n  issues: write\n  pull-requests: write" : "";
  const commentTokenLine = trigger !== "auto" ? "\n          github-token: ${{ github.token }}" : "";
  // /evaluate 게이트 — PR 대화의 코멘트이고 작성자가 협력자 이상일 때만(포크 PR 의 임의 코멘트로 평가 발화 방어).
  const commentGate =
    trigger !== "auto"
      ? `
    if: >-
      github.event_name != 'issue_comment' ||
      (github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/evaluate') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))`
      : "";
  // 코멘트 발화는 기본 브랜치 컨텍스트 — PR head 를 명시 체크아웃(그 외 이벤트는 빈 ref = 기본 동작).
  const checkoutRef =
    trigger !== "auto"
      ? `
        with:
          ref: \${{ github.event_name == 'issue_comment' && format('refs/pull/{0}/head', github.event.issue.number) || '' }}`
      : "";
  return `# Assay 가 생성한 CI eval 워크플로 — PR 은 임시 핀 평가, PR 코멘트 /evaluate 는 온디맨드 재평가, 기본 브랜치 push 는 재핀(새 버전)+평가.
# 셀프호스티드 러너 전용 — Assay 컨트롤플레인이 사설망이어도 러너가 도달할 수 있어야 합니다(GitHub-호스티드 미지원).
# 주의: 퍼블릭 레포의 fork PR 은 셀프호스티드 러너에서 임의 코드를 실행할 수 있습니다(프라이빗 팀 레포 전제).
name: assay-eval
on:
${onBlock}
permissions:
  contents: read
  packages: write
  id-token: write # Assay OIDC 페더레이션(keyless)${commentPermissions}
concurrency:
  group: assay-eval-\${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true
jobs:
  eval:
    runs-on: ${runsOn}${commentGate}
    steps:
      - uses: actions/checkout@v4${checkoutRef}
      - name: Resolve eval head
        id: head
        run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - uses: docker/login-action@v3
        with:
          registry: ${registry}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
${buildSteps}
      - name: Assay eval
        uses: assay-ai/run-eval@v1
        with:
          api-url: ${apiUrl}
          workspace: ${workspace}
          harness: ${link.harness}
          dataset: ${link.dataset ?? "# TODO: 데이터셋 id 를 지정하세요"}
          images: '${imagesJson}'
          head-sha: \${{ steps.head.outputs.sha }}${commentTokenLine}${runtimeLine}
`;
}
