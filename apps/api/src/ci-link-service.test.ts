import { NotFoundError, UpstreamError } from "@assay/core";
import { InMemoryWorkspaceSettingsStore } from "@assay/db";
import { beforeEach, describe, expect, it } from "vitest";
import { CiLinkService, type GithubAppRepoAccess, type RepoInfo, renderCiWorkflow } from "./ci-link-service.js";

// fetch fake — URL 패턴별 응답 시나리오(setup-PR 의 GitHub API dance 검증용).
type Handler = (url: string, init?: RequestInit) => Response | undefined;
function fakeFetch(handlers: Handler[], calls: Array<{ url: string; method: string; body?: unknown }>) {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    for (const h of handlers) {
      const res = h(url, init);
      if (res) return res;
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// 워크스페이스 GitHub App 능력의 fake — picker/쓰기토큰/러너토큰(개인 연결 대체). GithubAppService 자체는 별도 테스트.
function fakeGithubApp(over: Partial<GithubAppRepoAccess> = {}): GithubAppRepoAccess {
  return {
    listRepos: async () => [],
    tokenForRepository: async () => ({ token: "app_tok" }),
    runnerRegistrationToken: async () => ({ token: "RUNNER", expiresAt: "2026-07-04T12:00:00Z" }),
    ...over,
  };
}

describe("CiLinkService — link CRUD (repository당 1건, 대소문자 무시)", () => {
  let settings: InMemoryWorkspaceSettingsStore;
  let svc: CiLinkService;
  beforeEach(() => {
    settings = new InMemoryWorkspaceSettingsStore();
    svc = new CiLinkService({ settings, githubApp: fakeGithubApp() });
  });

  it("upsert 는 같은 repository 를 교체하고(createdBy 스탬프), remove 는 신뢰까지 끊는다", async () => {
    await svc.upsert("acme", "alice", { repository: "Acme/App", harness: "bu", slots: { planner: {} } });
    await svc.upsert("acme", "bob", { repository: "acme/app", harness: "bu", dataset: "pinch", slots: {} });
    const links = await svc.list("acme");
    expect(links).toHaveLength(1); // 대소문자 무시 교체
    expect(links[0]).toMatchObject({ repository: "acme/app", harness: "bu", dataset: "pinch", createdBy: "bob" });
    expect(await svc.remove("acme", "ACME/APP")).toEqual([]);
  });

  it("다른 워크스페이스 설정을 건드리지 않는다(워크스페이스 스코프)", async () => {
    await svc.upsert("acme", "alice", { repository: "acme/app", harness: "bu", slots: {} });
    expect(await svc.list("beta")).toEqual([]);
  });
});

describe("CiLinkService.listRepos — 워크스페이스 App installation repos picker (위임)", () => {
  it("githubApp.listRepos(workspace) 를 그대로 노출한다", async () => {
    const repos: RepoInfo[] = [{ fullName: "acme-org/api", private: true, defaultBranch: "main" }];
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp({ listRepos: async () => repos }),
    });
    expect(await svc.listRepos("acme")).toEqual(repos);
  });
});

describe("CiLinkService.openSetupPr — 워크플로 YAML 합성 + 브랜치/커밋/PR (App 토큰)", () => {
  function build(handlers: Handler[], calls: Array<{ url: string; method: string; body?: { content?: string } }>) {
    return new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp(), // token=app_tok
      apiPublicUrl: "https://assay.example.com",
      fetchImpl: fakeFetch(handlers, calls),
    });
  }

  it("link 로부터 YAML 을 만들고 branch→file→PR 순서로 생성해 prUrl 을 돌려준다", async () => {
    const calls: Array<{ url: string; method: string; body?: { content?: string; ref?: string } }> = [];
    const svc = build(
      [
        (url, init) => {
          const m = init?.method ?? "GET";
          if (url.endsWith("/repos/acme/app") && m === "GET") return json({ default_branch: "main" });
          if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "base-sha" } });
          if (url.endsWith("/git/refs") && m === "POST") return json({}, 201);
          if (url.includes("/contents/.github/workflows/assay-eval.yml") && m === "GET")
            return json({ message: "Not Found" }, 404);
          if (url.includes("/contents/.github/workflows/assay-eval.yml") && m === "PUT") return json({}, 201);
          if (url.endsWith("/pulls") && m === "POST")
            return json({ html_url: "https://github.com/acme/app/pull/42" }, 201);
          return undefined;
        },
      ],
      calls,
    );
    await svc.upsert("acme", "admin", {
      repository: "acme/app",
      harness: "my-topology",
      dataset: "pinch-bench",
      slots: { "svc-x": { path: "services/x" } },
    });
    const result = await svc.openSetupPr("acme", "acme/app");
    expect(result).toEqual({ prUrl: "https://github.com/acme/app/pull/42", branch: "assay/eval-setup" });

    // 커밋된 워크플로 내용 검증 — zero-input 의 실체: 워크스페이스/하니스/데이터셋/슬롯 빌드가 전부 박혀 있다.
    const put = calls.find((c) => c.method === "PUT");
    const yaml = Buffer.from(put?.body?.content ?? "", "base64").toString("utf8");
    expect(yaml).toContain("workspace: acme");
    expect(yaml).toContain("harness: my-topology");
    expect(yaml).toContain("dataset: pinch-bench");
    expect(yaml).toContain("id-token: write"); // OIDC keyless
    expect(yaml).toContain("context: services/x"); // 모노레포 path
    expect(yaml).toContain("build-svc-x"); // 슬롯 빌드 스텝 + digest 출력 참조
    expect(yaml).toContain("api-url: https://assay.example.com");
    expect(yaml).toContain("concurrency:"); // superseding
  });

  it("link 가 없으면 NotFound(신뢰 부여 전 PR 금지), GitHub 실패는 UpstreamError 로 remap", async () => {
    const svc = build([(url) => (url.endsWith("/repos/acme/app") ? json({ message: "boom" }, 500) : undefined)], []);
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(NotFoundError);
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {} });
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("App 이 그 repo 에 설치돼 있지 않으면 NotFound(tokenForRepository 가 던짐)", async () => {
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp({
        tokenForRepository: async () => {
          throw new NotFoundError("NOT_FOUND", {}, "설치된 App 없음");
        },
      }),
      apiPublicUrl: "https://assay.example.com",
      fetchImpl: fakeFetch([], []),
    });
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {} });
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("renderCiWorkflow", () => {
  it("dataset 미지정이면 TODO 주석을 남긴다(조용한 누락 금지)", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: {}, createdBy: "a" },
      "acme",
      "https://assay.example.com",
    );
    expect(yaml).toContain("TODO");
  });

  it("runsOn/runtime 미지정이면 ubuntu-latest + runtime 입력 없음(관리형 기본)", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: {}, createdBy: "a" },
      "acme",
      "https://assay.example.com",
    );
    expect(yaml).toContain("runs-on: ubuntu-latest");
    expect(yaml).not.toContain("runtime:");
  });

  it("runsOn/runtime 지정 시 셀프호스티드 배치(runs-on 라벨 + run-eval runtime 입력)", () => {
    const yaml = renderCiWorkflow(
      {
        repository: "acme/app",
        harness: "bu",
        slots: {},
        createdBy: "a",
        runsOn: "[self-hosted, assay-r1]",
        runtime: "self:ws:r1",
      },
      "acme",
      "https://assay.example.com",
    );
    expect(yaml).toContain("runs-on: [self-hosted, assay-r1]");
    expect(yaml).toContain("runtime: self:ws:r1");
  });
});

describe("CiLinkService.mintRunnerToken — 워크스페이스 App 으로 러너 등록 토큰(위임)", () => {
  it("githubApp.runnerRegistrationToken(workspace, target) 을 그대로 노출한다", async () => {
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp({
        runnerRegistrationToken: async (_ws, target) => ({
          token: "repo" in target ? "REPOTOK" : "ORGTOK",
          expiresAt: "2026-07-04T12:00:00Z",
        }),
      }),
    });
    expect((await svc.mintRunnerToken("acme", { repo: "acme/app" })).token).toBe("REPOTOK");
    expect((await svc.mintRunnerToken("acme", { org: "acme-org" })).token).toBe("ORGTOK");
  });
});
