import { InMemoryRunnerStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { CiLinkService, type GithubAppRepoAccess } from "./ci-link-service.js";
import { installGithubWorkspaceRunner } from "./github-runner-install.js";
import { RunnerService } from "./runner-service.js";

// The runner registration token is now issued by the workspace GitHub App (not a personal connection) — stubbed with a fake.
function fakeGithubApp(): GithubAppRepoAccess {
  return {
    listRepos: async () => [],
    tokenForRepository: async () => ({ token: "t" }),
    runnerRegistrationToken: async () => ({ token: "REG-TOKEN", expiresAt: "2026-07-04T12:00:00Z" }),
  };
}

function setup() {
  const runnerStore = new InMemoryRunnerStore();
  const runnerService = new RunnerService(runnerStore);
  const ciLinkService = new CiLinkService({
    settings: new InMemoryWorkspaceSettingsStore(),
    githubApp: fakeGithubApp(),
    runners: runnerService, // setup-PR's self:ws pool existence check (D6) — passes RunnerService through, as in real wiring
  });
  return { runnerService, ciLinkService, runnerStore };
}

describe("installGithubWorkspaceRunner — GitHub Actions runner self-registration (two workers on a build server)", () => {
  it("pairs a workspace-shared runner + mints a GitHub registration token + generates the install script/workflow hint", async () => {
    const { runnerService, ciLinkService, runnerStore } = setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      {
        workspace: "acme",
        repository: "acme/app",
        label: "acme-ci",
        apiUrl: "https://everdict.example.com",
        capabilities: ["git", "docker"],
      },
    );

    // Paired as a workspace-shared runner (owner=ws:acme) → targeted as self:ws:<id>.
    expect(res.runtimeTarget).toBe(`self:ws:${res.runner.id}`);
    expect(res.githubRunnerLabel).toBe(`everdict-${res.runner.id}`);
    expect(res.registrationExpiresAt).toBe("2026-07-04T12:00:00Z");
    const owned = await runnerStore.list("ws:acme");
    expect(owned.map((r) => r.id)).toContain(res.runner.id);

    // Install script: both the GitHub runner (config.sh + registration token) and the Everdict runner (everdict runner --pair + rnr_ token).
    expect(res.installScript).toContain("./config.sh");
    expect(res.installScript).toContain("https://github.com/acme/app");
    expect(res.installScript).toContain("REG-TOKEN");
    expect(res.installScript).toContain("everdict runner --pair");
    expect(res.installScript).toContain('--api-url "https://everdict.example.com"');
    expect(res.installScript).toMatch(/rnr_/); // the plaintext pairing token is embedded in the script

    // Workflow hint: runs-on label + run-eval runtime input.
    expect(res.workflowHint).toContain(`self-hosted, everdict-${res.runner.id}`);
    expect(res.workflowHint).toContain(`runtime: self:ws:${res.runner.id}`);
  });

  it("a repository not in 'owner/name' form → BAD_REQUEST (rejected before pairing)", async () => {
    const { runnerService, ciLinkService, runnerStore } = setup();
    await expect(
      installGithubWorkspaceRunner(
        { runnerService, ciLinkService },
        { workspace: "acme", repository: "not-a-repo", label: "x", apiUrl: "u" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await runnerStore.list("ws:acme")).toHaveLength(0); // no runner is created on invalid input
  });

  it("org level (org given): config.sh --url is the org URL (shared by all repos in that org)", async () => {
    const { runnerService, ciLinkService } = setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      { workspace: "acme", org: "acme-org", label: "org-ci", apiUrl: "https://a.example.com" },
    );
    expect(res.installScript).toContain("https://github.com/acme-org");
    expect(res.installScript).not.toContain("https://github.com/acme-org/"); // not a repo path (the org URL as-is)
    expect(res.runtimeTarget).toBe(`self:ws:${res.runner.id}`);
  });

  it("org level + runnerGroup: the install script includes --runnergroup", async () => {
    const { runnerService, ciLinkService } = setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      { workspace: "acme", org: "acme-org", runnerGroup: "everdict-pool", label: "x", apiUrl: "u" },
    );
    expect(res.installScript).toContain('--runnergroup "everdict-pool"');
  });

  it("repo level ignores runnerGroup (--runnergroup is a no-op for repo runners)", async () => {
    const { runnerService, ciLinkService } = setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      { workspace: "acme", repository: "a/b", runnerGroup: "ignored", label: "y", apiUrl: "u" },
    );
    expect(res.installScript).not.toContain("--runnergroup");
  });

  it("both repository and org, or neither → BAD_REQUEST", async () => {
    const { runnerService, ciLinkService } = setup();
    await expect(
      installGithubWorkspaceRunner(
        { runnerService, ciLinkService },
        { workspace: "acme", repository: "a/b", org: "a", label: "x", apiUrl: "u" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      installGithubWorkspaceRunner({ runnerService, ciLinkService }, { workspace: "acme", label: "x", apiUrl: "u" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
