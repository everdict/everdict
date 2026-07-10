import {
  CiLinkService,
  type GithubAppRepoAccess,
  type RepoInfo,
  type WorkspaceRunnerRoster,
  renderCiWorkflow,
} from "@everdict/application-control";
import { BadRequestError, NotFoundError, UpstreamError } from "@everdict/contracts";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { beforeEach, describe, expect, it } from "vitest";
import { githubRepoWriterFactory } from "../../infrastructure/github/repo-writer.js";

// fetch fake — per-URL-pattern response scenarios (to verify setup-PR's GitHub API dance).
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

// Fake of the workspace GitHub App capabilities — picker/write-token/runner-token (replacing personal connections). GithubAppService itself is tested separately.
function fakeGithubApp(over: Partial<GithubAppRepoAccess> = {}): GithubAppRepoAccess {
  return {
    listRepos: async () => [],
    tokenForRepository: async () => ({ token: "app_tok" }),
    runnerRegistrationToken: async () => ({ token: "RUNNER", expiresAt: "2026-07-04T12:00:00Z" }),
    ...over,
  };
}

// Fake workspace-shared runner roster — default 1 runner (r1). For setup-PR's self:ws pool fail-closed check (D6).
function fakeRunners(ids: string[] = ["r1"]): WorkspaceRunnerRoster {
  return { listWorkspaceOwned: async () => ids.map((id) => ({ id })) };
}

describe("CiLinkService — link CRUD (one record per repository, case-insensitive)", () => {
  let settings: InMemoryWorkspaceSettingsStore;
  let svc: CiLinkService;
  beforeEach(() => {
    settings = new InMemoryWorkspaceSettingsStore();
    svc = new CiLinkService({ settings, githubApp: fakeGithubApp(), runners: fakeRunners() });
  });

  it("upsert replaces the same repository (stamps createdBy), and remove severs the trust too", async () => {
    await svc.upsert("acme", "alice", { repository: "Acme/App", harness: "bu", slots: { planner: {} } });
    await svc.upsert("acme", "bob", { repository: "acme/app", harness: "bu", dataset: "pinch", slots: {} });
    const links = await svc.list("acme");
    expect(links).toHaveLength(1); // case-insensitive replace
    expect(links[0]).toMatchObject({ repository: "acme/app", harness: "bu", dataset: "pinch", createdBy: "bob" });
    expect(await svc.remove("acme", "ACME/APP")).toEqual([]);
  });

  it("the trigger knob (auto|comment|both) is stored on the link — how the setup-PR workflow's PR fires", async () => {
    await svc.upsert("acme", "alice", { repository: "acme/app", harness: "bu", slots: {}, trigger: "comment" });
    expect((await svc.list("acme"))[0]?.trigger).toBe("comment");
  });

  it("personal-runner runtime (self / self:<id>) is BadRequest — a CI principal cannot lease a personal runner (block the fire-time failure at save)", async () => {
    for (const runtime of ["self", "self:r9"])
      await expect(
        svc.upsert("acme", "alice", { repository: "acme/app", harness: "bu", slots: {}, runtime }),
      ).rejects.toBeInstanceOf(BadRequestError);
    // The workspace-shared family and managed runtime ids are allowed (including generic ids starting with "self").
    for (const runtime of ["self:ws", "self:ws:r1", "k8s-prod", "selfhosted-k8s"])
      await expect(
        svc.upsert("acme", "alice", { repository: "acme/app", harness: "bu", slots: {}, runtime }),
      ).resolves.toBeDefined();
  });

  it("does not touch another workspace's settings (workspace scope)", async () => {
    await svc.upsert("acme", "alice", { repository: "acme/app", harness: "bu", slots: {} });
    expect(await svc.list("beta")).toEqual([]);
  });

  it("link key is (host, repository) — the same owner/name coexists as separate links on github.com and a GHE", async () => {
    await svc.upsert("acme", "alice", { repository: "acme/app", harness: "bu", slots: {} });
    await svc.upsert("acme", "alice", {
      repository: "acme/app",
      host: "https://ghe.acme.io",
      harness: "bu-ghe",
      slots: {},
    });
    expect(await svc.list("acme")).toHaveLength(2);

    // Only an upsert on the same host replaces (host comparison ignores case/trailing slash).
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

    // remove also narrows by host — only the GHE link is deleted, the github.com link remains.
    const after = await svc.remove("acme", "acme/app", "https://ghe.acme.io");
    expect(after).toHaveLength(1);
    expect(after[0]?.host).toBeUndefined();
  });
});

describe("CiLinkService.listRepos — workspace App installation repos picker (delegation)", () => {
  it("exposes githubApp.listRepos(workspace) verbatim", async () => {
    const repos: RepoInfo[] = [{ fullName: "acme-org/api", private: true, defaultBranch: "main" }];
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp({ listRepos: async () => repos }),
      runners: fakeRunners(),
    });
    expect(await svc.listRepos("acme")).toEqual(repos);
  });
});

describe("CiLinkService.openSetupPr — workflow YAML synthesis + branch/commit/PR (App token)", () => {
  function build(handlers: Handler[], calls: Array<{ url: string; method: string; body?: { content?: string } }>) {
    return new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp(), // token=app_tok
      runners: fakeRunners(), // 1 runner in the self:ws pool (r1) — passes the default placement check
      apiPublicUrl: "https://everdict.example.com",
      repoWriter: githubRepoWriterFactory(fakeFetch(handlers, calls)),
    });
  }

  it("builds the YAML from the link, creates it in branch→file→PR order, and returns prUrl", async () => {
    const calls: Array<{ url: string; method: string; body?: { content?: string; ref?: string } }> = [];
    const svc = build(
      [
        (url, init) => {
          const m = init?.method ?? "GET";
          if (url.endsWith("/repos/acme/app") && m === "GET") return json({ default_branch: "main" });
          if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "base-sha" } });
          if (url.endsWith("/git/refs") && m === "POST") return json({}, 201);
          if (url.includes("/contents/.github/workflows/everdict-eval.yml") && m === "GET")
            return json({ message: "Not Found" }, 404);
          if (url.includes("/contents/.github/workflows/everdict-eval.yml") && m === "PUT") return json({}, 201);
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
    expect(result).toEqual({ prUrl: "https://github.com/acme/app/pull/42", branch: "everdict/eval-setup" });

    // Verify the committed workflow content — the substance of zero-input: workspace/harness/dataset/slot builds are all baked in.
    const put = calls.find((c) => c.method === "PUT");
    const yaml = Buffer.from(put?.body?.content ?? "", "base64").toString("utf8");
    expect(yaml).toContain("workspace: acme");
    expect(yaml).toContain("harness: my-topology");
    expect(yaml).toContain("dataset: pinch-bench");
    expect(yaml).toContain("id-token: write"); // OIDC keyless
    expect(yaml).toContain("context: services/x"); // monorepo path
    expect(yaml).toContain("build-svc-x"); // slot build step + digest output reference
    expect(yaml).toContain("api-url: https://everdict.example.com");
    expect(yaml).toContain("concurrency:"); // superseding
  });

  it("no link → NotFound (no PR before trust is granted); a GitHub failure remaps to UpstreamError", async () => {
    const svc = build([(url) => (url.endsWith("/repos/acme/app") ? json({ message: "boom" }, 500) : undefined)], []);
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(NotFoundError);
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {} });
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("a GHE link mints the token by link.host and dances against the GHE API (/api/v3)", async () => {
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
      runners: fakeRunners(),
      apiPublicUrl: "https://everdict.example.com",
      repoWriter: githubRepoWriterFactory(
        fakeFetch(
          [
            (url, init) => {
              const m = init?.method ?? "GET";
              if (!url.startsWith("https://ghe.acme.io/api/v3/")) return undefined; // anything but the GHE base → 500
              if (url.endsWith("/repos/acme/app") && m === "GET") return json({ default_branch: "main" });
              if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "base-sha" } });
              if (url.endsWith("/git/refs") && m === "POST") return json({}, 201);
              if (url.includes("/contents/.github/workflows/everdict-eval.yml") && m === "GET")
                return json({ message: "Not Found" }, 404);
              if (url.includes("/contents/.github/workflows/everdict-eval.yml") && m === "PUT") return json({}, 201);
              if (url.endsWith("/pulls") && m === "POST")
                return json({ html_url: "https://ghe.acme.io/acme/app/pull/3" }, 201);
              return undefined;
            },
          ],
          calls,
        ),
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
    expect(tokenHosts).toEqual(["https://ghe.acme.io"]); // link.host is passed through as the installation selector
    expect(calls.every((c) => c.url.startsWith("https://ghe.acme.io/api/v3/"))).toBe(true);
  });

  it("if the App is not installed on that repo → NotFound (tokenForRepository throws)", async () => {
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp({
        tokenForRepository: async () => {
          throw new NotFoundError("NOT_FOUND", {}, "no installed App");
        },
      }),
      runners: fakeRunners(),
      apiPublicUrl: "https://everdict.example.com",
      repoWriter: githubRepoWriterFactory(fakeFetch([], [])),
    });
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {} });
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(NotFoundError);
  });

  // D6 — CI placement is always self-hosted: if the default runtime (self:ws pool) is empty, fail-closed before opening the PR.
  it("does not open setup-PR when there are zero shared runners (BadRequest) — post-merge infinite queueing on GitHub is the latest failure", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp(),
      runners: fakeRunners([]), // no workspace-shared runner
      apiPublicUrl: "https://everdict.example.com",
      repoWriter: githubRepoWriterFactory(fakeFetch([], calls)),
    });
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {} });
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(BadRequestError);
    expect(calls).toHaveLength(0); // created no branch/commit/PR on GitHub whatsoever
  });

  it("runtime is a specific runner (self:ws:<id>) not in the roster → NotFound — advises re-register or clear runtime to the pool (self:ws)", async () => {
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp(),
      runners: fakeRunners(["r1"]),
      apiPublicUrl: "https://everdict.example.com",
      repoWriter: githubRepoWriterFactory(fakeFetch([], [])),
    });
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {}, runtime: "self:ws:gone" });
    await expect(svc.openSetupPr("acme", "acme/app")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a managed-runtime override (runtime not in the self:ws family) opens the PR even with no runner roster", async () => {
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp(),
      runners: fakeRunners([]), // no shared runner — irrelevant for a managed runtime
      apiPublicUrl: "https://everdict.example.com",
      repoWriter: githubRepoWriterFactory(
        fakeFetch(
          [
            (url, init) => {
              const m = init?.method ?? "GET";
              if (url.endsWith("/repos/acme/app") && m === "GET") return json({ default_branch: "main" });
              if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "base-sha" } });
              if (url.endsWith("/git/refs") && m === "POST") return json({}, 201);
              if (url.includes("/contents/.github/workflows/everdict-eval.yml") && m === "GET")
                return json({ message: "Not Found" }, 404);
              if (url.includes("/contents/.github/workflows/everdict-eval.yml") && m === "PUT") return json({}, 201);
              if (url.endsWith("/pulls") && m === "POST")
                return json({ html_url: "https://github.com/acme/app/pull/7" }, 201);
              return undefined;
            },
          ],
          [],
        ),
      ),
    });
    await svc.upsert("acme", "admin", { repository: "acme/app", harness: "bu", slots: {}, runtime: "k8s-prod" });
    await expect(svc.openSetupPr("acme", "acme/app")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/app/pull/7",
    });
  });
});

describe("renderCiWorkflow", () => {
  it("leaves a TODO comment when dataset is unset (no silent omission)", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: {}, createdBy: "a" },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).toContain("TODO");
  });

  it("with runsOn/runtime unset, defaults to self-hosted ([self-hosted] + self:ws pool) — no GitHub-hosted path (D6)", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: {}, createdBy: "a" },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).toContain("runs-on: [self-hosted]");
    expect(yaml).toContain("runtime: self:ws");
    expect(yaml).not.toContain("ubuntu-latest");
  });

  it("with runsOn/runtime set, self-hosted placement (runs-on label + run-eval runtime input)", () => {
    const yaml = renderCiWorkflow(
      {
        repository: "acme/app",
        harness: "bu",
        slots: {},
        createdBy: "a",
        runsOn: "[self-hosted, everdict-r1]",
        runtime: "self:ws:r1",
      },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).toContain("runs-on: [self-hosted, everdict-r1]");
    expect(yaml).toContain("runtime: self:ws:r1");
  });

  it("a github.com link builds/pushes to GHCR (the default registry)", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: { web: {} }, createdBy: "a" },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).toContain("registry: ghcr.io");
    // Image tag is the checked-out head's sha — on a comment fire (default-branch context) GITHUB_SHA points at main.
    expect(yaml).toContain("tags: ghcr.io/${{ github.repository }}/web:${{ steps.head.outputs.sha }}");
  });

  it("a GHE link builds/pushes to that instance's container registry (containers.<hostname>) — GHES's GITHUB_TOKEN cannot log in to ghcr.io", () => {
    const yaml = renderCiWorkflow(
      {
        repository: "acme/app",
        host: "https://ghe.acme.io",
        harness: "bu",
        slots: { web: {} },
        createdBy: "a",
      },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).toContain("registry: containers.ghe.acme.io");
    expect(yaml).toContain("tags: containers.ghe.acme.io/${{ github.repository }}/web:${{ steps.head.outputs.sha }}");
    expect(yaml).toContain('"web":"containers.ghe.acme.io/${{ github.repository }}/web@');
    expect(yaml).not.toContain("ghcr.io");
  });

  it("default (trigger unset = both) fires both PR auto + /evaluate comment — absorbs the 3 issue_comment pitfalls", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: {}, createdBy: "a" },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).toContain("\n  pull_request:");
    expect(yaml).toContain("\n  issue_comment:");
    // ① gate — only /evaluate on a PR conversation when the author is a collaborator or above (fork-PR defense).
    expect(yaml).toContain("startsWith(github.event.comment.body, '/evaluate')");
    expect(yaml).toContain("github.event.comment.author_association");
    // ② default-branch context pitfall — explicit PR head checkout + resolve the sha via git.
    expect(yaml).toContain("format('refs/pull/{0}/head', github.event.issue.number)");
    expect(yaml).toContain("git rev-parse HEAD");
    // ③ group concurrency by PR number so a comment fire ↔ the same PR's auto fire supersede each other.
    expect(yaml).toContain("github.event.pull_request.number || github.event.issue.number || github.ref");
    // Write permission + token for conversation replies (the only feedback surface).
    expect(yaml).toContain("pull-requests: write");
    expect(yaml).toContain("github-token: ${{ github.token }}");
  });

  it("trigger=auto does not emit the comment trigger/gate/feedback permissions (auto fire only — least privilege)", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: {}, createdBy: "a", trigger: "auto" },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).toContain("\n  pull_request:");
    expect(yaml).not.toContain("issue_comment");
    expect(yaml).not.toContain("issues: write");
    expect(yaml).not.toContain("github-token");
  });

  it("trigger=comment fires only the /evaluate comment without the PR auto trigger (on demand) — push re-pin stays", () => {
    const yaml = renderCiWorkflow(
      { repository: "acme/app", harness: "bu", slots: {}, createdBy: "a", trigger: "comment" },
      "acme",
      "https://everdict.example.com",
    );
    expect(yaml).not.toContain("\n  pull_request:");
    expect(yaml).toContain("\n  issue_comment:");
    expect(yaml).toContain("\n  push:");
  });
});

describe("CiLinkService.mintRunnerToken — runner registration token via the workspace App (delegation)", () => {
  it("exposes githubApp.runnerRegistrationToken(workspace, target, host) verbatim", async () => {
    const svc = new CiLinkService({
      settings: new InMemoryWorkspaceSettingsStore(),
      githubApp: fakeGithubApp({
        runnerRegistrationToken: async (_ws, target, host) => ({
          token: "repo" in target ? "REPOTOK" : "ORGTOK",
          expiresAt: "2026-07-04T12:00:00Z",
          ...(host !== undefined ? { host } : {}),
        }),
      }),
      runners: fakeRunners(),
    });
    expect((await svc.mintRunnerToken("acme", { repo: "acme/app" })).token).toBe("REPOTOK");
    expect((await svc.mintRunnerToken("acme", { org: "acme-org" })).token).toBe("ORGTOK");
    // host threading — the GHE installation the picker chose is passed through verbatim.
    expect((await svc.mintRunnerToken("acme", { org: "acme-org" }, "https://ghe.acme.io")).host).toBe(
      "https://ghe.acme.io",
    );
  });
});
