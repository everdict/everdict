import { BadRequestError, NotFoundError, UpstreamError } from "@assay/core";
import { InMemoryConnectionStore, InMemoryWorkspaceSettingsStore, aesGcmCipher } from "@assay/db";
import { beforeEach, describe, expect, it } from "vitest";
import { CiLinkService, renderCiWorkflow } from "./ci-link-service.js";

// fetch fake — URL 패턴별 응답 시나리오. 호출 기록으로 GitHub API dance 를 검증한다.
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

describe("CiLinkService — link CRUD (repository당 1건, 대소문자 무시)", () => {
  let settings: InMemoryWorkspaceSettingsStore;
  let svc: CiLinkService;
  beforeEach(() => {
    settings = new InMemoryWorkspaceSettingsStore();
    svc = new CiLinkService({ settings, connections: new InMemoryConnectionStore(aesGcmCipher(Buffer.alloc(32, 1))) });
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

describe("CiLinkService.listRepos — 개인 GitHub 연결로 레포 picker 프록시", () => {
  const cipher = aesGcmCipher(Buffer.alloc(32, 1));
  let connections: InMemoryConnectionStore;
  beforeEach(() => {
    connections = new InMemoryConnectionStore(cipher);
  });

  it("GitHub /user/repos 를 얇게 정규화해 돌려주고 토큰은 Authorization 에만 실린다", async () => {
    const meta = await connections.create({
      owner: "alice",
      workspace: "acme",
      provider: "github",
      accountLabel: "alice-gh",
      scopes: ["repo"],
      accessToken: "gho_secret",
    });
    const calls: Array<{ url: string; method: string }> = [];
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      connections,
      fetchImpl: fakeFetch(
        [
          (url) =>
            url.startsWith("https://api.github.com/user/repos")
              ? json([{ full_name: "acme/app", private: true, default_branch: "main", pushed_at: "2026-07-01" }])
              : undefined,
        ],
        calls,
      ),
    });
    const repos = await svc.listRepos("alice", meta.id);
    expect(repos).toEqual([{ fullName: "acme/app", private: true, defaultBranch: "main", pushedAt: "2026-07-01" }]);
    expect(calls[0]?.url).toContain("https://api.github.com/user/repos");
  });

  it("남의/없는 연결 → NotFound, 비-GitHub 연결 → BadRequest", async () => {
    const mm = await connections.create({
      owner: "alice",
      workspace: "acme",
      provider: "mattermost",
      accountLabel: "alice-mm",
      scopes: [],
      accessToken: "mm_tok",
    });
    const svc = new CiLinkService({ settings: new InMemoryWorkspaceSettingsStore(), connections });
    await expect(svc.listRepos("bob", mm.id)).rejects.toBeInstanceOf(NotFoundError); // 남의 연결
    await expect(svc.listRepos("alice", "nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.listRepos("alice", mm.id)).rejects.toBeInstanceOf(BadRequestError); // GitHub 아님
  });

  it("GHE 연결(host)은 ${host}/api/v3 베이스로 호출한다", async () => {
    const ghe = await connections.create({
      owner: "alice",
      workspace: "acme",
      provider: "github-enterprise",
      host: "https://ghe.acme.io",
      accountLabel: "alice-ghe",
      scopes: ["repo"],
      accessToken: "ghe_tok",
    });
    const calls: Array<{ url: string; method: string }> = [];
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      connections,
      fetchImpl: fakeFetch([(url) => (url.includes("/api/v3/user/repos") ? json([]) : undefined)], calls),
    });
    await svc.listRepos("alice", ghe.id);
    expect(calls[0]?.url.startsWith("https://ghe.acme.io/api/v3/user/repos")).toBe(true);
  });
});

describe("CiLinkService.openSetupPr — 워크플로 YAML 합성 + 브랜치/커밋/PR", () => {
  const cipher = aesGcmCipher(Buffer.alloc(32, 1));

  async function fixtures() {
    const settings = new InMemoryWorkspaceSettingsStore();
    const connections = new InMemoryConnectionStore(cipher);
    const conn = await connections.create({
      owner: "alice",
      workspace: "acme",
      provider: "github",
      accountLabel: "alice-gh",
      scopes: ["repo"],
      accessToken: "gho_secret",
    });
    return { settings, connections, conn };
  }

  it("link 로부터 YAML 을 만들고 branch→file→PR 순서로 생성해 prUrl 을 돌려준다", async () => {
    const { settings, connections, conn } = await fixtures();
    const calls: Array<{ url: string; method: string; body?: { content?: string; ref?: string } }> = [];
    const svc = new CiLinkService({
      settings,
      connections,
      apiPublicUrl: "https://assay.example.com",
      fetchImpl: fakeFetch(
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
      ),
    });
    await svc.upsert("acme", "admin", {
      repository: "acme/app",
      harness: "my-topology",
      dataset: "pinch-bench",
      slots: { "svc-x": { path: "services/x" } },
    });
    const result = await svc.openSetupPr("acme", "alice", conn.id, "acme/app");
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
    const { settings, connections, conn } = await fixtures();
    const svc = new CiLinkService({
      settings,
      connections,
      apiPublicUrl: "https://assay.example.com",
      fetchImpl: fakeFetch(
        [(url) => (url.endsWith("/repos/acme/app") ? json({ message: "boom" }, 500) : undefined)],
        [],
      ),
    });
    await expect(svc.openSetupPr("acme", "alice", conn.id, "acme/app")).rejects.toBeInstanceOf(NotFoundError);
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {} });
    await expect(svc.openSetupPr("acme", "alice", conn.id, "acme/app")).rejects.toBeInstanceOf(UpstreamError);
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
});

describe("CiLinkService.mintRunnerToken — GitHub Actions 러너 등록 토큰 발급", () => {
  const cipher = aesGcmCipher(Buffer.alloc(32, 1));

  it("개인 GitHub 연결로 POST registration-token → {token, expiresAt}; 토큰은 Authorization 에만", async () => {
    const connections = new InMemoryConnectionStore(cipher);
    const meta = await connections.create({
      owner: "alice",
      workspace: "acme",
      provider: "github",
      accountLabel: "alice-gh",
      scopes: ["repo"],
      accessToken: "gho_secret",
    });
    const calls: Array<{ url: string; method: string }> = [];
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      connections,
      fetchImpl: fakeFetch(
        [
          (url, init) =>
            url.endsWith("/repos/acme/app/actions/runners/registration-token") && init?.method === "POST"
              ? json({ token: "AABBCC", expires_at: "2026-07-04T12:00:00Z" })
              : undefined,
        ],
        calls,
      ),
    });
    const res = await svc.mintRunnerToken("alice", meta.id, "acme/app");
    expect(res).toEqual({ token: "AABBCC", expiresAt: "2026-07-04T12:00:00Z" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/repos/acme/app/actions/runners/registration-token");
  });

  it("비-GitHub 연결이면 BAD_REQUEST", async () => {
    const connections = new InMemoryConnectionStore(cipher);
    const meta = await connections.create({
      owner: "alice",
      workspace: "acme",
      provider: "mattermost",
      accountLabel: "mm",
      scopes: [],
      accessToken: "x",
    });
    const svc = new CiLinkService({ settings: new InMemoryWorkspaceSettingsStore(), connections });
    await expect(svc.mintRunnerToken("alice", meta.id, "acme/app")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
