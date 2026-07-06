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

  it("link 키는 (host, repository) — 같은 owner/name 이라도 github.com 과 GHE 는 별개 link 로 공존한다", async () => {
    await svc.upsert("acme", "alice", { repository: "acme/app", harness: "bu", slots: {} });
    await svc.upsert("acme", "alice", {
      repository: "acme/app",
      host: "https://ghe.acme.io",
      harness: "bu-ghe",
      slots: {},
    });
    expect(await svc.list("acme")).toHaveLength(2);

    // 같은 host 의 upsert 만 교체된다(host 비교는 대소문자/트레일링 슬래시 무시).
    await svc.upsert("acme", "bob", {
      repository: "ACME/APP",
      host: "https://GHE.acme.io/",
      harness: "bu-ghe-v2",
      slots: {},
    });
    const links = await svc.list("acme");
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.host !== undefined)?.harness).toBe("bu-ghe-v2");
    expect(links.find((l) => l.host === undefined)?.harness).toBe("bu");

    // remove 도 host 로 좁힌다 — GHE link 만 지워지고 github.com link 는 남는다.
    const after = await svc.remove("acme", "acme/app", "https://ghe.acme.io");
    expect(after).toHaveLength(1);
    expect(after[0]?.host).toBeUndefined();
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

  it("GHE link 는 link.host 로 토큰을 발급하고 GHE API(/api/v3)로 dance 한다", async () => {
    const calls: Array<{ url: string; method: string; body?: { content?: string } }> = [];
    const tokenHosts: Array<string | undefined> = [];
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp({
        tokenForRepository: async (_ws, _repo, _perm, host) => {
          tokenHosts.push(host);
          return { token: "app_tok", ...(host ? { host } : {}) };
        },
      }),
      apiPublicUrl: "https://assay.example.com",
      fetchImpl: fakeFetch(
        [
          (url, init) => {
            const m = init?.method ?? "GET";
            if (!url.startsWith("https://ghe.acme.io/api/v3/")) return undefined; // GHE 베이스 이외는 500
            if (url.endsWith("/repos/acme/app") && m === "GET") return json({ default_branch: "main" });
            if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "base-sha" } });
            if (url.endsWith("/git/refs") && m === "POST") return json({}, 201);
            if (url.includes("/contents/.github/workflows/assay-eval.yml") && m === "GET")
              return json({ message: "Not Found" }, 404);
            if (url.includes("/contents/.github/workflows/assay-eval.yml") && m === "PUT") return json({}, 201);
            if (url.endsWith("/pulls") && m === "POST")
              return json({ html_url: "https://ghe.acme.io/acme/app/pull/3" }, 201);
            return undefined;
          },
        ],
        calls,
      ),
    });
    await svc.upsert("acme", "admin", {
      repository: "acme/app",
      host: "https://ghe.acme.io",
      harness: "bu",
      slots: { app: {} },
    });
    const result = await svc.openSetupPr("acme", "acme/app", { host: "https://ghe.acme.io" });
    expect(result.prUrl).toBe("https://ghe.acme.io/acme/app/pull/3");
    expect(tokenHosts).toEqual(["https://ghe.acme.io"]); // link.host 가 installation 선택으로 전달
    expect(calls.every((c) => c.url.startsWith("https://ghe.acme.io/api/v3/"))).toBe(true);
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

  it("github.com link 는 GHCR 로 빌드/푸시한다(레지스트리 기본값)", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: { web: {} }, createdBy: "a" },
      "acme",
      "https://assay.example.com",
    );
    expect(yaml).toContain("registry: ghcr.io");
    expect(yaml).toContain("tags: ghcr.io/${{ github.repository }}/web:${{ github.sha }}");
  });

  it("GHE link 는 그 인스턴스의 컨테이너 레지스트리(containers.<hostname>)로 빌드/푸시한다 — GHES 의 GITHUB_TOKEN 은 ghcr.io 로그인 불가", () => {
    const yaml = renderCiWorkflow(
      {
        repository: "acme/app",
        host: "https://ghe.acme.io",
        harness: "bu",
        slots: { web: {} },
        createdBy: "a",
      },
      "acme",
      "https://assay.example.com",
    );
    expect(yaml).toContain("registry: containers.ghe.acme.io");
    expect(yaml).toContain("tags: containers.ghe.acme.io/${{ github.repository }}/web:${{ github.sha }}");
    expect(yaml).toContain('"web":"containers.ghe.acme.io/${{ github.repository }}/web@');
    expect(yaml).not.toContain("ghcr.io");
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
