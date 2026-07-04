import { BadRequestError, NotFoundError, UpstreamError } from "@assay/core";
import type { ConnectionStore, WorkspaceCiLink, WorkspaceSettingsStore } from "@assay/db";
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

export interface CiLinkServiceDeps {
  settings: WorkspaceSettingsStore;
  connections: ConnectionStore; // 멤버 개인 연결 토큰(tokenFor) — repos 프록시 + setup-PR 커밋/PR 용
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

  // picker — 멤버 개인 GitHub 연결(owner=subject)로 그 계정의 레포 목록을 프록시. 토큰은 서버 안에서만.
  async listRepos(owner: string, connectionId: string, page = 1): Promise<RepoInfo[]> {
    const { token, host } = await this.githubToken(owner, connectionId);
    const res = await this.gh(
      `${apiBase(host)}/user/repos?sort=pushed&per_page=50&page=${page}&affiliation=owner,collaborator,organization_member`,
      token,
    );
    const rows = z
      .array(
        z.object({
          full_name: z.string(),
          private: z.boolean(),
          default_branch: z.string(),
          pushed_at: z.string().nullable().optional(),
        }),
      )
      .parse(await res.json());
    return rows.map((r) => ({
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      ...(r.pushed_at ? { pushedAt: r.pushed_at } : {}),
    }));
  }

  // setup-PR — link 로부터 워크플로 YAML 을 합성해 대상 레포에 브랜치+커밋+PR 을 연다(호출자의 개인 연결 토큰).
  // 멱등에 가깝게: 브랜치/PR 이 이미 있으면 재사용/기존 PR 반환. 머지 여부는 GitHub 쪽 사람의 결정.
  async openSetupPr(
    workspace: string,
    owner: string,
    connectionId: string,
    repository: string,
    requestBaseUrl?: string,
  ): Promise<{ prUrl: string; branch: string }> {
    const link = (await this.list(workspace)).find(
      (l) => l.repository.toLowerCase() === repository.toLowerCase() && !l.disabled,
    );
    if (!link) throw new NotFoundError("NOT_FOUND", { repository }, `'${repository}' 의 repo link 가 없습니다.`);
    const { token, host } = await this.githubToken(owner, connectionId);
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

  // GitHub Actions 셀프호스티드 러너 등록 토큰 발급 — 멤버 개인 GitHub 연결로 그 대상(repo|org)에 대해 mint.
  // 단기 토큰(≈1시간). Assay 는 장기 러너 토큰을 저장하지 않는다(필요 시마다 발급).
  //  - repo 레벨: 기본 스코프(repo)면 충분. POST /repos/{owner/name}/actions/runners/registration-token.
  //  - org 레벨(옵트인): admin:org 스코프 필요. POST /orgs/{org}/actions/runners/registration-token — 권한 없으면 403 을
  //    "상향 권한으로 재연결" 안내(BadRequest)로 remap(원시 403 을 그대로 흘리지 않는다).
  // 반환에 host 도 실어 install 스크립트가 config.sh --url 를 github.com/GHE 로 맞추게 한다. 설계 doc §4.
  async mintRunnerToken(
    owner: string,
    connectionId: string,
    target: { repo: string } | { org: string },
  ): Promise<{ token: string; expiresAt: string; host?: string }> {
    const { token, host } = await this.githubToken(owner, connectionId);
    const path = "repo" in target ? `/repos/${target.repo}` : `/orgs/${target.org}`;
    const res = await this.fetch(`${apiBase(host)}${path}/actions/runners/registration-token`, {
      method: "POST",
      headers: this.headers(token),
    });
    if (!res.ok) {
      if ("org" in target && (res.status === 403 || res.status === 404))
        throw new BadRequestError(
          "BAD_REQUEST",
          { org: target.org, status: res.status },
          "org 러너 등록 토큰 발급 실패 — 이 GitHub 연결에 admin:org 권한이 없거나 org 접근이 없습니다. 상향 권한(admin:org)으로 GitHub 를 다시 연결한 뒤 시도하세요.",
        );
      throw await this.upstream(res, "러너 등록 토큰 발급 실패");
    }
    const data = z.object({ token: z.string(), expires_at: z.string() }).parse(await res.json());
    return { token: data.token, expiresAt: data.expires_at, ...(host !== undefined ? { host } : {}) };
  }

  private async githubToken(owner: string, connectionId: string): Promise<{ token: string; host?: string }> {
    const metas = await this.deps.connections.list(owner);
    const meta = metas.find((m) => m.id === connectionId);
    if (!meta) throw new NotFoundError("NOT_FOUND", { connectionId }, "연결을 찾을 수 없습니다.");
    if (meta.provider !== "github" && meta.provider !== "github-enterprise")
      throw new BadRequestError("BAD_REQUEST", { provider: meta.provider }, "GitHub 연결이 아닙니다.");
    const tok = await this.deps.connections.tokenFor(owner, connectionId);
    if (!tok) throw new NotFoundError("NOT_FOUND", { connectionId }, "연결 토큰이 없습니다.");
    return { token: tok.accessToken, ...(meta.host !== undefined ? { host: meta.host } : {}) };
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
