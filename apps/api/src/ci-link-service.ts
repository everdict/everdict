import { BadRequestError, NotFoundError, UpstreamError } from "@assay/core";
import type { WorkspaceCiLink, WorkspaceSettingsStore } from "@assay/db";
import { z } from "zod";

// CI repo link 서비스 — repository ↔ 하니스 서비스 슬롯 매핑(= GitHub Actions OIDC trust policy) CRUD +
// 멤버 개인 GitHub 연결로 레포 목록 프록시(picker) + setup-PR 생성기(워크플로 YAML 을 대상 레포에 PR).
// "별다른 입력 없이": picker 에서 레포 선택 → link 저장 → setup-PR 버튼 → 머지 — 사용자는 YAML/키를 만지지 않는다.
// 설계: docs/architecture/github-actions-trigger.md (D3). HTTP 라우트와 MCP 도구가 같은 코어를 공유(BFF↔MCP 패리티).

export const UpsertCiLinkBodySchema = z.object({
  repository: z.string().min(1), // "owner/name"
  harness: z.string().min(1), // 하니스 인스턴스 id
  dataset: z.string().optional(), // 발사할 데이터셋 id — setup-PR 워크플로 생성에 필요(없으면 YAML 에 TODO)
  slots: z.record(z.object({ path: z.string().optional() })).default({}), // 서비스 슬롯 → 모노레포 path(선택)
  runsOn: z.string().min(1).optional(), // 셀프호스티드 배치(선택) — 워크플로 runs-on(예: "[self-hosted, assay-<id>]")
  runtime: z.string().min(1).optional(), // run-eval runtime 입력(예: "self:ws:<id>") — 평가를 워크스페이스-공유 러너에서
});
export type UpsertCiLinkBody = z.infer<typeof UpsertCiLinkBodySchema>;

// picker 한 행 — GitHub API 응답을 얇게 정규화(무거운 원본 미노출).
export interface RepoInfo {
  fullName: string; // "owner/name"
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
  ): Promise<{ token: string; host?: string }>;
  runnerRegistrationToken(
    workspace: string,
    target: { repo: string } | { org: string },
  ): Promise<{ token: string; expiresAt: string; host?: string }>;
}

export interface CiLinkServiceDeps {
  settings: WorkspaceSettingsStore;
  githubApp: GithubAppRepoAccess; // 워크스페이스 소유 GitHub App — repos picker + setup-PR 커밋/PR + 러너 등록 토큰
  apiPublicUrl?: string; // 생성 워크플로의 api-url 값(미설정이면 요청 base 폴백)
  fetchImpl?: typeof fetch; // 테스트 주입
}

// GitHub API 베이스 — github.com 은 api. 서브도메인, GHE 는 /api/v3 (연결의 host 로 판별).
function apiBase(host?: string): string {
  return host ? `${host.replace(/\/$/, "")}/api/v3` : "https://api.github.com";
}

export class CiLinkService {
  private readonly fetch: typeof fetch;
  constructor(private readonly deps: CiLinkServiceDeps) {
    this.fetch = deps.fetchImpl ?? fetch;
  }

  async list(workspace: string): Promise<WorkspaceCiLink[]> {
    return (await this.deps.settings.get(workspace))?.ci?.links ?? [];
  }

  // upsert — repository(대소문자 무시)당 1건. link 의 존재가 그 레포의 OIDC trust 이므로 생성=신뢰 부여(admin 게이트는 라우트).
  async upsert(workspace: string, subject: string, body: UpsertCiLinkBody): Promise<WorkspaceCiLink[]> {
    const current = await this.list(workspace);
    const next: WorkspaceCiLink = {
      repository: body.repository,
      harness: body.harness,
      slots: body.slots,
      createdBy: subject,
      ...(body.dataset !== undefined ? { dataset: body.dataset } : {}),
      ...(body.runsOn !== undefined ? { runsOn: body.runsOn } : {}),
      ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
    };
    const rest = current.filter((l) => l.repository.toLowerCase() !== body.repository.toLowerCase());
    await this.deps.settings.set(workspace, { ci: { links: [...rest, next] } });
    return this.list(workspace);
  }

  async remove(workspace: string, repository: string): Promise<WorkspaceCiLink[]> {
    const current = await this.list(workspace);
    const rest = current.filter((l) => l.repository.toLowerCase() !== repository.toLowerCase());
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
    requestBaseUrl?: string,
  ): Promise<{ prUrl: string; branch: string }> {
    const link = (await this.list(workspace)).find(
      (l) => l.repository.toLowerCase() === repository.toLowerCase() && !l.disabled,
    );
    if (!link) throw new NotFoundError("NOT_FOUND", { repository }, `'${repository}' 의 repo link 가 없습니다.`);
    // 워크스페이스 App installation 토큰(쓰기) — 브랜치/파일/PR 을 만들려면 contents + pull_requests write.
    const { token, host } = await this.deps.githubApp.tokenForRepository(workspace, link.repository, {
      contents: "write",
      pull_requests: "write",
    });
    const base = apiBase(host);
    const apiUrl = this.deps.apiPublicUrl ?? requestBaseUrl;
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

// link → 워크플로 YAML 합성 — 사용자는 YAML 을 만지지 않는다(zero-input 의 핵심).
// PR/push 겸용 한 파일: 슬롯별 이미지 빌드(GHCR, digest 출력) → assay run-eval 액션(모드 자동, OIDC keyless).
// 모노레포 최적화(path filter 로 바뀐 슬롯만 빌드)는 후속 — v1 은 링크된 슬롯 전부 빌드(정확성 우선).
export function renderCiWorkflow(link: WorkspaceCiLink, workspace: string, apiUrl: string): string {
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
        `          tags: ghcr.io/\${{ github.repository }}/${slot}:\${{ github.sha }}`,
      ].join("\n"),
    )
    .join("\n");
  const imagesJson = `{${slots
    .map(([slot]) => `"${slot}":"ghcr.io/\${{ github.repository }}/${slot}@\${{ steps.build-${slot}.outputs.digest }}"`)
    .join(",")}}`;
  // 셀프호스티드 배치(선택): runsOn 지정 시 그 러너에서 잡을 돌리고, runtime 지정 시 평가를 워크스페이스-공유 러너로.
  const runsOn = link.runsOn ?? "ubuntu-latest";
  const runtimeLine = link.runtime ? `\n          runtime: ${link.runtime}` : "";
  return `# Assay 가 생성한 CI eval 워크플로 — PR 은 임시 핀 평가, 기본 브랜치 push 는 재핀(새 버전)+평가.
name: assay-eval
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  packages: write
  id-token: write # Assay OIDC 페더레이션(keyless)
concurrency:
  group: assay-eval-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  eval:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
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
          images: '${imagesJson}'${runtimeLine}
`;
}
