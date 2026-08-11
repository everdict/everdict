import { generateKeyPairSync } from "node:crypto";
import { GithubAppService } from "@everdict/application-control";
import { BadRequestError, NotFoundError } from "@everdict/contracts";
import { InMemoryOAuthStateStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubAppGateway } from "../../infrastructure/github/app-gateway.js";
import { githubRepoTreeReaderFactory, githubRepoWriterFactory } from "../../infrastructure/github/repo-writer.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const NOW = new Date("2026-07-05T00:00:00Z");
// The operator env GitHub Enterprise App — one App per host for the whole deployment (handled identically to github.com).
const ENTERPRISE_HOST = "https://ghe.acme.io";

afterEach(() => vi.unstubAllGlobals());

// Stub only the GET /app/installations/{id} response (confirm the install account).
function stubInstallation(login: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: 1, account: { login } }), { status: 200 })),
  );
}

// Branch by URL to stub installation lookup + access-token minting (for tokenForRepo).
function stubGithub(login: string, token: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const body = String(url).endsWith("/access_tokens")
        ? { token, expires_at: "2026-07-05T12:00:00Z" }
        : { id: 1, account: { login } };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Composite stub for App capabilities — branch by URL over access_tokens / installation lookup / installation repos / runner registration token.
function stubApi(repos: string[], runnerTok = "RUNNERTOK"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/installation/repositories")
          ? {
              repositories: repos.map((r) => ({
                full_name: r,
                private: true,
                default_branch: "main",
                pushed_at: "2026-07-01T00:00:00Z",
              })),
            }
          : s.endsWith("/registration-token")
            ? { token: runnerTok, expires_at: "2026-07-05T12:00:00Z" }
            : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Stub for the repo read ops — installation lookup + access-token mint + contents/issues, branched by URL.
function stubRepoOps(opts: { fileB64?: string; issues?: unknown[] }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/contents/")
          ? { type: "file", path: "README.md", sha: "abc", size: 5, content: opts.fileB64 ?? "", encoding: "base64" }
          : s.includes("/issues")
            ? (opts.issues ?? [])
            : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Stub for the repo TREE read — access-token mint + the default-branch lookup + GET /git/trees/{ref}?recursive=1.
// Directories ride along as "tree" entries so the filter that keeps only blobs is exercised, not assumed.
function stubRepoTree(paths: string[], opts: { truncated?: boolean } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/git/trees/")
          ? {
              tree: [{ path: "src", type: "tree" }, ...paths.map((path) => ({ path, type: "blob" }))],
              truncated: opts.truncated ?? false,
            }
          : s.endsWith("/repos/acme-org/api")
            ? { default_branch: "main" }
            : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Stub for the single-issue read — access-token mint + GET issue + GET its comments. The comments branch is
// tested FIRST because its URL also contains "/issues".
function stubIssueRead(comments: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/comments")
          ? Array.from({ length: comments }, (_, i) => ({
              body: `comment ${i}`,
              created_at: "2026-07-02T00:00:00Z",
              html_url: `https://gh/c/${i}`,
              user: { login: "dev" },
            }))
          : s.includes("/issues/")
            ? {
                number: 5,
                title: "bug",
                state: "open",
                html_url: "https://gh/5",
                updated_at: "2026-07-02T00:00:00Z",
                body: "steps to reproduce",
                labels: [{ name: "bug" }],
                user: { login: "reporter" },
              }
            : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Stub for the PR change read — access-token mint + GET pull (changed_files) + GET its files. The files branch
// is tested first for the same reason as comments above.
function stubPullFiles(changedFiles: number, files: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/files")
          ? files
          : s.includes("/pulls/")
            ? { changed_files: changedFiles }
            : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Stub for the direct-commit path — access-token mint + repoHead (default branch + its sha) + branch creation +
// the contents PUT (whose response names the commit). Records every mutating call so the ORDER is assertable.
function stubCommit(calls: { method: string; url: string }[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const s = String(url);
      const method = init?.method ?? "GET";
      // Only the REPOSITORY mutations are recorded — minting the installation token is also a POST, and it is
      // plumbing, not a write to anybody's repo.
      if (method !== "GET" && !s.endsWith("/access_tokens")) calls.push({ method, url: s });
      // The adapter looks the path up first to learn whether this is a create or an update; 404 = new file.
      if (method === "GET" && s.includes("/contents/")) return new Response("{}", { status: 404 });
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/git/ref/heads/")
          ? { object: { sha: "headsha" } }
          : s.includes("/contents/")
            ? { content: { path: "x" }, commit: { sha: "c" } }
            : s.endsWith("/repos/acme-org/api")
              ? { default_branch: "main" }
              : s.includes("/git/refs")
                ? { ref: "created" }
                : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

// Stub for the repo write ops — access-token mint + POST issue / POST comment, branched by URL.
function stubRepoWrite(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const s = String(url);
      const body = s.endsWith("/access_tokens")
        ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
        : s.includes("/comments")
          ? { html_url: "https://gh/acme-org/api/issues/5#comment-1" }
          : s.endsWith("/issues")
            ? { number: 5, html_url: "https://gh/acme-org/api/issues/5" }
            : { id: 1, account: { login: "acme-org" } }; // getInstallation
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("GithubAppService", () => {
  let states: InMemoryOAuthStateStore;
  let settings: InMemoryWorkspaceSettingsStore;
  let svc: GithubAppService;

  beforeEach(() => {
    states = new InMemoryOAuthStateStore(() => NOW.toISOString());
    settings = new InMemoryWorkspaceSettingsStore();
    svc = new GithubAppService({
      states,
      settings,
      gateway: githubAppGateway(), // fake fetch (vi.stubGlobal) routes through the real adapter → wire assertions survive
      repoOps: githubRepoWriterFactory(), // same fake-fetch-through-real-adapter for the repo read ops
      trees: githubRepoTreeReaderFactory(), // and for the repo's file tree (the "what is in here" read)

      config: {
        webBaseUrl: "http://web.test",
        apiPublicUrl: "http://api.test",
        // Both providers are operator env — one App per host, install-only (no per-workspace App registration).
        githubCom: { appId: "111", privateKeyPem: privateKey, slug: "everdict-eval" },
        githubEnterprise: { host: ENTERPRISE_HOST, appId: "222", privateKeyPem: privateKey, slug: "everdict-ghe" },
      },
      now: () => NOW,
    });
  });

  it("list reports the configured providers (github.com + enterprise, both operator env) with no per-workspace registrations", async () => {
    const view = await svc.list("acme");
    expect(view.providers).toEqual({ githubCom: true, enterprise: { host: ENTERPRISE_HOST } });
    expect(view.installations).toEqual([]);
  });

  it("starting a github.com install makes a /apps/{slug}/installations/new URL + state", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u-admin" });
    const u = new URL(installUrl);
    expect(u.origin + u.pathname).toBe("https://github.com/apps/everdict-eval/installations/new");
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it("starting an enterprise install (the operator env host) → {host}/github-apps/{slug}/installations/new URL", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u", host: ENTERPRISE_HOST });
    expect(new URL(installUrl).origin + new URL(installUrl).pathname).toBe(
      "https://ghe.acme.io/github-apps/everdict-ghe/installations/new",
    );
  });

  it("starting an install for a host that isn't the configured enterprise host → BadRequestError", async () => {
    await expect(
      svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://other-ghe.example.com" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("the enterprise host is matched with normalized equality — trailing-slash/case differences still resolve the install URL", async () => {
    const { installUrl } = await svc.startInstall({ workspace: "acme", createdBy: "u", host: "https://GHE.Acme.io/" });
    // The install URL uses the configured host form (not the caller's notation).
    expect(installUrl).toContain("https://ghe.acme.io/github-apps/everdict-ghe/installations/new");
  });

  it("the callback: installation_id+state → confirm account, then record the install on the workspace", async () => {
    stubInstallation("acme-org");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-1", { workspace: "acme", provider: "github-app", createdBy: "u-admin" }, future);

    const { redirectTo } = await svc.callback({ installationId: 42, state: "st-1" });
    expect(redirectTo).toContain("/acme/settings?tab=integrations");
    expect(redirectTo).toContain("githubApp=installed");

    const view = await svc.list("acme");
    expect(view.installations).toEqual([
      { installationId: 42, account: "acme-org", connectedBy: "u-admin", connectedAt: NOW.toISOString() },
    ]);
  });

  it("a bad/expired state callback → error redirect (no install recorded)", async () => {
    const { redirectTo } = await svc.callback({ installationId: 42, state: "nope" });
    expect(redirectTo).toContain("error=invalid_state");
    expect((await svc.list("acme")).installations).toEqual([]);
  });

  it("an enterprise callback confirms the account with the operator env enterprise App creds (no SecretStore)", async () => {
    stubInstallation("ghe-team");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put(
      "st-ghe",
      { workspace: "acme", provider: "github-app", createdBy: "u", host: ENTERPRISE_HOST },
      future,
    );

    await svc.callback({ installationId: 7, state: "st-ghe" });
    const view = await svc.list("acme");
    expect(view.installations[0]).toMatchObject({ installationId: 7, account: "ghe-team", host: ENTERPRISE_HOST });
  });

  it("unlinking an installation removes the record idempotently", async () => {
    stubInstallation("acme-org");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-2", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-2" });

    const after = await svc.unlinkInstallation("acme", 42);
    expect(after.installations).toEqual([]);
    expect((await svc.unlinkInstallation("acme", 42)).installations).toEqual([]); // idempotent
  });

  it("tokenForRepo: when the git URL owner matches a workspace installation, mints a repo-scoped token", async () => {
    stubGithub("acme-org", "ghs_repo");
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-t", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-t" }); // records install with account=acme-org

    const tok = await svc.tokenForRepo("acme", "https://github.com/acme-org/api.git");
    expect(tok).toBe("ghs_repo");
  });

  it("tokenForRepo: no matching installation → undefined (fallback is the caller's job)", async () => {
    stubGithub("acme-org", "ghs_repo");
    expect(await svc.tokenForRepo("acme", "https://github.com/other-org/api")).toBeUndefined();
  });

  // App capabilities — replacing personal connections: picker / write token / runner registration token.
  async function installOrg(): Promise<void> {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    await states.put("st-x", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
    await svc.callback({ installationId: 42, state: "st-x" }); // install with account=acme-org
  }

  it("listRepos normalizes and returns the repos the installation can access (only the ones chosen at install time)", async () => {
    stubApi(["acme-org/api", "acme-org/web"]);
    await installOrg();
    const repos = await svc.listRepos("acme");
    expect(repos.map((r) => r.fullName)).toEqual(["acme-org/api", "acme-org/web"]);
    expect(repos[0]).toMatchObject({ private: true, defaultBranch: "main" });
  });

  it("tokenForRepository mints that repo's installation token with the specified permissions", async () => {
    stubApi([]);
    await installOrg();
    const out = await svc.tokenForRepository("acme", "acme-org/api", {
      contents: "write",
      pull_requests: "write",
    });
    expect(out.token).toBe("ghs_inst");
  });

  it("tokenForRepository → NotFound when there is no matching installation", async () => {
    stubApi([]);
    await installOrg();
    await expect(svc.tokenForRepository("acme", "other-org/api", {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("getRepoFile mints a repo-scoped token and returns the base64-decoded file content", async () => {
    stubRepoOps({ fileB64: Buffer.from("hello world", "utf8").toString("base64") });
    await installOrg();
    const file = await svc.getRepoFile("acme", "acme-org/api", "README.md");
    expect(file).toEqual({ path: "README.md", content: "hello world", sha: "abc", size: 5 });
  });

  it("getRepoFile → NotFound when the App is not installed on the repo owner", async () => {
    stubRepoOps({});
    await installOrg();
    await expect(svc.getRepoFile("acme", "other-org/api", "README.md")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listRepoFiles lists the repo's blobs on the default branch — the read that makes get_github_file usable", async () => {
    stubRepoTree(["README.md", "src/a.ts", "src/nested/b.ts"]);
    await installOrg();
    const tree = await svc.listRepoFiles("acme", "acme-org/api", {});
    expect(tree).toEqual({ paths: ["README.md", "src/a.ts", "src/nested/b.ts"], truncated: false });
  });

  it("listRepoFiles narrows to a prefix (a subtree, not a substring match)", async () => {
    stubRepoTree(["README.md", "src/a.ts", "src/nested/b.ts", "srcextra/c.ts"]);
    await installOrg();
    const tree = await svc.listRepoFiles("acme", "acme-org/api", { prefix: "/src/" });
    expect(tree).toEqual({ paths: ["src/a.ts", "src/nested/b.ts"], truncated: false });
  });

  it("listRepoFiles REPORTS its own bound — a limited page is truncated:true, never a silent short repository", async () => {
    stubRepoTree(["a.ts", "b.ts", "c.ts"]);
    await installOrg();
    const tree = await svc.listRepoFiles("acme", "acme-org/api", { limit: 2 });
    expect(tree).toEqual({ paths: ["a.ts", "b.ts"], truncated: true });
  });

  it("listRepoFiles propagates GitHub's own truncated flag even when every path fits", async () => {
    stubRepoTree(["a.ts"], { truncated: true });
    await installOrg();
    await expect(svc.listRepoFiles("acme", "acme-org/api", {})).resolves.toEqual({
      paths: ["a.ts"],
      truncated: true,
    });
  });

  it("listRepoFiles → NotFound when the App is not installed on the repo owner", async () => {
    stubRepoTree([]);
    await installOrg();
    await expect(svc.listRepoFiles("acme", "other-org/api", {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listRepoIssues returns issues and PRs (PRs flagged), clamping the limit", async () => {
    stubRepoOps({
      issues: [
        {
          number: 7,
          title: "bug",
          state: "open",
          html_url: "https://gh/7",
          updated_at: "2026-07-02T00:00:00Z",
          user: { login: "dev" },
        },
        {
          number: 8,
          title: "feat",
          state: "open",
          html_url: "https://gh/8",
          updated_at: "2026-07-01T00:00:00Z",
          user: { login: "dev" },
          pull_request: { url: "x" },
        },
      ],
    });
    await installOrg();
    const issues = await svc.listRepoIssues("acme", "acme-org/api", { limit: 500 });
    expect(issues).toEqual([
      {
        number: 7,
        title: "bug",
        state: "open",
        author: "dev",
        url: "https://gh/7",
        isPullRequest: false,
        updatedAt: "2026-07-02T00:00:00Z",
        // Labels ride along for the tracker's imported copies (GitHub owns them); always present, possibly empty.
        labels: [],
      },
      {
        number: 8,
        title: "feat",
        state: "open",
        author: "dev",
        url: "https://gh/8",
        isPullRequest: true,
        updatedAt: "2026-07-01T00:00:00Z",
        labels: [],
      },
    ]);
  });

  it("getRepoIssue returns the issue WITH its comment thread — the report, not just the row", async () => {
    stubIssueRead(2);
    await installOrg();
    const out = await svc.getRepoIssue("acme", "acme-org/api", 5, {});
    expect(out.issue).toMatchObject({ number: 5, title: "bug", body: "steps to reproduce", labels: ["bug"] });
    expect(out.comments.map((c) => c.body)).toEqual(["comment 0", "comment 1"]);
    expect(out.commentsTruncated).toBe(false);
  });

  it("getRepoIssue reports a truncated thread instead of presenting a partial one as the whole discussion", async () => {
    stubIssueRead(5); // asks for maxComments+1 and gets more than the cap
    await installOrg();
    const out = await svc.getRepoIssue("acme", "acme-org/api", 5, { maxComments: 2 });
    expect(out.comments).toHaveLength(2);
    expect(out.commentsTruncated).toBe(true);
  });

  it("listPullRequestChanges returns the per-file diff and flags a listing short of the PR's own count", async () => {
    stubPullFiles(3, [
      { filename: "src/a.ts", status: "modified", additions: 4, deletions: 1, patch: "@@ -1 +1 @@" },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 }, // binary: no patch, counts still hold
    ]);
    await installOrg();
    const out = await svc.listPullRequestChanges("acme", "acme-org/api", 7, {});
    expect(out.changedFiles).toBe(3);
    expect(out.files).toEqual([
      { filename: "src/a.ts", status: "modified", additions: 4, deletions: 1, patch: "@@ -1 +1 @@" },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(out.truncated).toBe(true); // 2 of 3 — a review written against this must know
  });

  it("commitFiles creates the branch off the default branch, commits each file, and names every commit", async () => {
    const calls: { method: string; url: string }[] = [];
    stubCommit(calls);
    await installOrg();
    const out = await svc.commitFiles("acme", "acme-org/api", {
      branch: "everdict/fix",
      message: "fix the thing",
      changes: [
        { path: "src/a.ts", content: "a" },
        { path: "src/b.ts", content: "b" },
      ],
    });
    expect(out).toEqual({
      branch: "everdict/fix",
      base: "main",
      createdBranch: true,
      files: ["src/a.ts", "src/b.ts"],
      headSha: "headsha", // read from the BRANCH after the writes — the sha names what landed
    });
    // Branch first, then the files in the order given — never a file onto a branch that does not exist yet.
    expect(calls.map((c) => `${c.method} ${c.url.split("/repos/acme-org/api")[1]}`)).toEqual([
      "POST /git/refs",
      "PUT /contents/src/a.ts",
      "PUT /contents/src/b.ts",
    ]);
  });

  it("commitFiles does not try to CREATE the default branch — committing to it is a different act, not a new branch", async () => {
    const calls: { method: string; url: string }[] = [];
    stubCommit(calls);
    await installOrg();
    const out = await svc.commitFiles("acme", "acme-org/api", {
      branch: "main",
      message: "hotfix",
      changes: [{ path: "src/a.ts", content: "a" }],
    });
    expect(out.createdBranch).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["PUT"]); // no POST /git/refs
  });

  it("commitFiles refuses an empty change set rather than making an empty branch", async () => {
    const calls: { method: string; url: string }[] = [];
    stubCommit(calls);
    await installOrg();
    await expect(
      svc.commitFiles("acme", "acme-org/api", { branch: "b", message: "m", changes: [] }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(calls).toEqual([]); // and does it BEFORE minting a write token
  });

  it("setIssueState closes an issue — state only, so the author's title and body survive it", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const s = String(url);
        if ((init?.method ?? "GET") !== "GET")
          calls.push({
            method: init?.method ?? "GET",
            url: s,
            ...(typeof init?.body === "string" ? { body: init.body } : {}),
          });
        const body = s.endsWith("/access_tokens")
          ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
          : { id: 1, account: { login: "acme-org" } };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await installOrg();
    const out = await svc.setIssueState("acme", "acme-org/api", 5, "closed");
    expect(out).toEqual({ number: 5, state: "closed" });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/issues/5");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ state: "closed" }); // nothing else is sent
  });

  it("createIssue mints an issues:write token and returns the new issue number + URL", async () => {
    stubRepoWrite();
    await installOrg();
    const out = await svc.createIssue("acme", "acme-org/api", { title: "bug", body: "broken" });
    expect(out).toEqual({ number: 5, url: "https://gh/acme-org/api/issues/5" });
  });

  it("commentOnIssue posts a comment and returns its URL", async () => {
    stubRepoWrite();
    await installOrg();
    const out = await svc.commentOnIssue("acme", "acme-org/api", 5, "on it");
    expect(out).toEqual({ url: "https://gh/acme-org/api/issues/5#comment-1" });
  });

  // Stub for the PR write ops — access-token mint + repo head + branch/contents/pulls, branched by URL; records the
  // mutating calls so the write ORDER (branch → files → PR) is assertable.
  function stubPrWrite(opts: { branchStatus?: number; prStatus?: number } = {}): {
    calls: { method: string; url: string; body?: unknown }[];
  } {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const s = String(url);
        const method = init?.method ?? "GET";
        if (method !== "GET")
          calls.push({ method, url: s, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (s.endsWith("/access_tokens"))
          return new Response(JSON.stringify({ token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }), {
            status: 200,
          });
        if (s.endsWith("/repos/acme-org/api"))
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
        if (s.includes("/git/ref/heads/main"))
          return new Response(JSON.stringify({ object: { sha: "base-sha" } }), { status: 200 });
        if (s.includes("/git/refs")) return new Response("{}", { status: opts.branchStatus ?? 201 });
        if (s.includes("/contents/") && method === "GET") return new Response("{}", { status: 404 }); // new file
        if (s.includes("/contents/")) return new Response("{}", { status: 201 });
        if (s.endsWith("/pulls") && method === "POST")
          return new Response(
            JSON.stringify(
              (opts.prStatus ?? 201) === 201 ? { html_url: "https://gh/acme-org/api/pull/9" } : { message: "exists" },
            ),
            { status: opts.prStatus ?? 201 },
          );
        if (s.includes("/pulls?head="))
          return new Response(JSON.stringify([{ html_url: "https://gh/acme-org/api/pull/8" }]), { status: 200 });
        return new Response(JSON.stringify({ id: 1, account: { login: "acme-org" } }), { status: 200 }); // getInstallation
      }),
    );
    return { calls };
  }

  it("openPullRequest commits each change on the branch then opens the PR against the default branch (branch → files → PR)", async () => {
    const { calls } = stubPrWrite();
    await installOrg();
    const out = await svc.openPullRequest("acme", "acme-org/api", {
      branch: "everdict/scorecard-sc-1",
      title: "fix: handle empty cart",
      body: "## What failed\nscorecard sc-1 …",
      changes: [
        { path: "src/cart.ts", content: "export const cart = 1;\n" },
        { path: "src/cart.test.ts", content: "test();\n" },
      ],
    });
    expect(out).toEqual({ url: "https://gh/acme-org/api/pull/9", branch: "everdict/scorecard-sc-1", base: "main" });
    const writes = calls.filter((c) => !c.url.endsWith("/access_tokens"));
    expect(writes.map((c) => c.url.split("/api/").at(-1))).toEqual([
      "git/refs",
      "contents/src/cart.ts",
      "contents/src/cart.test.ts",
      "pulls",
    ]);
    expect(writes[0]?.body).toMatchObject({ ref: "refs/heads/everdict/scorecard-sc-1", sha: "base-sha" });
    expect(writes[3]?.body).toMatchObject({ head: "everdict/scorecard-sc-1", base: "main" });
  });

  it("openPullRequest is near-idempotent — an existing branch (422) is reused and an already-open PR is returned", async () => {
    stubPrWrite({ branchStatus: 422, prStatus: 422 });
    await installOrg();
    const out = await svc.openPullRequest("acme", "acme-org/api", {
      branch: "everdict/scorecard-sc-1",
      title: "fix",
      body: "ctx",
      changes: [{ path: "src/cart.ts", content: "x" }],
    });
    expect(out.url).toBe("https://gh/acme-org/api/pull/8"); // the existing open PR, not an error
  });

  it("openPullRequest with no changes → BadRequestError before any GitHub call", async () => {
    const { calls } = stubPrWrite();
    await installOrg();
    await expect(
      svc.openPullRequest("acme", "acme-org/api", { branch: "b", title: "t", body: "b", changes: [] }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(calls.filter((c) => !c.url.endsWith("/access_tokens"))).toEqual([]);
  });

  it("createIssue → NotFound when the App is not installed on the repo owner", async () => {
    stubRepoWrite();
    await installOrg();
    await expect(svc.createIssue("acme", "other-org/api", { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runnerRegistrationToken mints a runner registration token via the App (administration)", async () => {
    stubApi([]);
    await installOrg();
    const out = await svc.runnerRegistrationToken("acme", { org: "acme-org" });
    expect(out.token).toBe("RUNNERTOK");
  });

  // Enterprise host threading — even if the same org name is on both github.com/GHE, picks the exact installation by host.
  describe("enterprise host threading", () => {
    // stubApi + record the call URLs (observe which host's installation minted the token).
    function stubApiRecording(repos: string[]): string[] {
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const s = String(url);
          urls.push(s);
          const body = s.endsWith("/access_tokens")
            ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
            : s.includes("/installation/repositories")
              ? {
                  repositories: repos.map((r) => ({
                    full_name: r,
                    private: true,
                    default_branch: "main",
                    pushed_at: "2026-07-01T00:00:00Z",
                  })),
                }
              : s.endsWith("/registration-token")
                ? { token: "RUNNERTOK", expires_at: "2026-07-05T12:00:00Z" }
                : { id: 1, account: { login: "acme-org" } };
          return new Response(JSON.stringify(body), { status: 200 });
        }),
      );
      return urls;
    }

    // Install both github.com (id 42) + enterprise (id 7, same account) — the ambiguity scenario. Both creds are operator env.
    async function installBothHosts(): Promise<void> {
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      await states.put("st-com", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
      await svc.callback({ installationId: 42, state: "st-com" });
      await states.put(
        "st-ghe2",
        { workspace: "acme", provider: "github-app", createdBy: "u", host: ENTERPRISE_HOST },
        future,
      );
      await svc.callback({ installationId: 7, state: "st-ghe2" });
    }

    it("listRepos carries host on the enterprise installation's repos (github.com is unmarked)", async () => {
      stubApiRecording([]);
      await installBothHosts();
      stubApiRecording(["acme-org/api"]);
      const repos = await svc.listRepos("acme");
      expect(repos).toHaveLength(2); // one from each of the two installations
      expect(repos.find((r) => r.host === undefined)?.fullName).toBe("acme-org/api");
      expect(repos.find((r) => r.host === ENTERPRISE_HOST)?.fullName).toBe("acme-org/api");
    });

    it("tokenForRepository picks the installation by host — enterprise (id 7) when the enterprise host is given, github.com (id 42) when absent", async () => {
      stubApiRecording([]);
      await installBothHosts();

      let urls = stubApiRecording([]);
      const ghe = await svc.tokenForRepository("acme", "acme-org/api", {}, ENTERPRISE_HOST);
      expect(ghe.host).toBe(ENTERPRISE_HOST);
      expect(urls.some((u) => u.startsWith("https://ghe.acme.io/api/v3/app/installations/7/access_tokens"))).toBe(true);

      urls = stubApiRecording([]);
      const com = await svc.tokenForRepository("acme", "acme-org/api", {});
      expect(com.host).toBeUndefined();
      expect(urls.some((u) => u.startsWith("https://api.github.com/app/installations/42/access_tokens"))).toBe(true);
    });

    it("runnerRegistrationToken picks the installation by host — enterprise (id 7) when a host is given, github.com (id 42) preferred when unset", async () => {
      stubApiRecording([]);
      await installBothHosts();

      // host given → mint only from that enterprise installation (host-strict).
      let urls = stubApiRecording([]);
      const ghe = await svc.runnerRegistrationToken("acme", { org: "acme-org" }, ENTERPRISE_HOST);
      expect(ghe.host).toBe(ENTERPRISE_HOST);
      expect(urls.some((u) => u.startsWith("https://ghe.acme.io/api/v3/app/installations/7/access_tokens"))).toBe(true);
      expect(urls.some((u) => u.includes("/orgs/acme-org/actions/runners/registration-token"))).toBe(true);

      // host unset → github.com installation wins even when the same owner is on both (removes ambiguity).
      urls = stubApiRecording([]);
      const com = await svc.runnerRegistrationToken("acme", { org: "acme-org" });
      expect(com.host).toBeUndefined();
      expect(urls.some((u) => u.startsWith("https://api.github.com/app/installations/42/access_tokens"))).toBe(true);
    });

    it("runnerRegistrationToken is NotFound when the given host has no installation (won't fall back to mint from another host)", async () => {
      stubApiRecording([]);
      await installBothHosts();
      await expect(
        svc.runnerRegistrationToken("acme", { org: "acme-org" }, "https://other.example.com"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("viewWithRepos bundles the allowed repos into each installation and soft-fails only the failed installation with reposError", async () => {
      stubApiRecording([]);
      await installBothHosts(); // github.com(42) + enterprise(7) — both account=acme-org
      // Enterprise installation's repo lookup fails (500) → only that entry gets reposError; github.com stays fine.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const s = String(url);
          if (s.startsWith("https://ghe.acme.io") && s.includes("/installation/repositories"))
            return new Response("upstream boom", { status: 500 });
          const body = s.endsWith("/access_tokens")
            ? { token: "ghs_inst", expires_at: "2026-07-05T12:00:00Z" }
            : s.includes("/installation/repositories")
              ? {
                  repositories: [
                    {
                      full_name: "acme-org/api",
                      private: true,
                      default_branch: "main",
                      pushed_at: "2026-07-01T00:00:00Z",
                    },
                  ],
                }
              : { id: 1, account: { login: "acme-org" } };
          return new Response(JSON.stringify(body), { status: 200 });
        }),
      );
      const view = await svc.viewWithRepos("acme");
      const com = view.installations.find((i) => i.host === undefined);
      const ghe = view.installations.find((i) => i.host === ENTERPRISE_HOST);
      expect(com?.repos?.map((r) => r.fullName)).toEqual(["acme-org/api"]);
      expect(com?.reposError).toBeUndefined();
      expect(ghe?.repos).toBeUndefined();
      expect(ghe?.reposError).toBeTruthy(); // a human-readable status only, not a raw GitHub/credential error
    });

    it("tokenForRepo regression: an enterprise git URL does not mint a token from a github.com installation (host-strict)", async () => {
      stubGithub("acme-org", "ghs_repo");
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      await states.put("st-y", { workspace: "acme", provider: "github-app", createdBy: "u" }, future);
      await svc.callback({ installationId: 42, state: "st-y" }); // only the github.com installation exists
      expect(await svc.tokenForRepo("acme", "https://ghe.acme.io/acme-org/api.git")).toBeUndefined();
    });
  });
});
