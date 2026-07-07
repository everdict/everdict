import { InMemoryRunnerStore, InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { CiLinkService, type GithubAppRepoAccess } from "./ci-link-service.js";
import { installGithubWorkspaceRunner } from "./github-runner-install.js";
import { RunnerService } from "./runner-service.js";

// 러너 등록 토큰은 이제 워크스페이스 GitHub App 이 발급(개인 연결 아님) — fake 로 대역.
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
    runners: runnerService, // setup-PR 의 self:ws 풀 존재 검사(D6) — 실제 배선과 동일하게 RunnerService 를 그대로
  });
  return { runnerService, ciLinkService, runnerStore };
}

describe("installGithubWorkspaceRunner — GitHub Actions 러너 자가등록(빌드 서버에 두 워커)", () => {
  it("워크스페이스-공유 러너 페어링 + GitHub 등록 토큰 mint + 설치 스크립트/워크플로 힌트 생성", async () => {
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

    // 워크스페이스-공유 러너로 페어링됨(owner=ws:acme) → self:ws:<id> 로 타깃.
    expect(res.runtimeTarget).toBe(`self:ws:${res.runner.id}`);
    expect(res.githubRunnerLabel).toBe(`everdict-${res.runner.id}`);
    expect(res.registrationExpiresAt).toBe("2026-07-04T12:00:00Z");
    const owned = await runnerStore.list("ws:acme");
    expect(owned.map((r) => r.id)).toContain(res.runner.id);

    // 설치 스크립트: GitHub 러너(config.sh + 등록 토큰) + Everdict 러너(everdict runner --pair + rnr_ 토큰) 둘 다.
    expect(res.installScript).toContain("./config.sh");
    expect(res.installScript).toContain("https://github.com/acme/app");
    expect(res.installScript).toContain("REG-TOKEN");
    expect(res.installScript).toContain("everdict runner --pair");
    expect(res.installScript).toContain('--api-url "https://everdict.example.com"');
    expect(res.installScript).toMatch(/rnr_/); // 페어링 평문 토큰이 스크립트에 실림

    // 워크플로 힌트: runs-on 라벨 + run-eval runtime 입력.
    expect(res.workflowHint).toContain(`self-hosted, everdict-${res.runner.id}`);
    expect(res.workflowHint).toContain(`runtime: self:ws:${res.runner.id}`);
  });

  it("repository 형식이 'owner/name' 이 아니면 BAD_REQUEST(페어링 전에 거절)", async () => {
    const { runnerService, ciLinkService, runnerStore } = setup();
    await expect(
      installGithubWorkspaceRunner(
        { runnerService, ciLinkService },
        { workspace: "acme", repository: "not-a-repo", label: "x", apiUrl: "u" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await runnerStore.list("ws:acme")).toHaveLength(0); // 잘못된 입력에 러너를 만들지 않음
  });

  it("org 레벨(org 지정): config.sh --url 가 org URL(그 org 의 모든 레포 공유)", async () => {
    const { runnerService, ciLinkService } = setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      { workspace: "acme", org: "acme-org", label: "org-ci", apiUrl: "https://a.example.com" },
    );
    expect(res.installScript).toContain("https://github.com/acme-org");
    expect(res.installScript).not.toContain("https://github.com/acme-org/"); // repo 경로 아님(org URL 그대로)
    expect(res.runtimeTarget).toBe(`self:ws:${res.runner.id}`);
  });

  it("org 레벨 + runnerGroup: 설치 스크립트에 --runnergroup 포함", async () => {
    const { runnerService, ciLinkService } = setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      { workspace: "acme", org: "acme-org", runnerGroup: "everdict-pool", label: "x", apiUrl: "u" },
    );
    expect(res.installScript).toContain('--runnergroup "everdict-pool"');
  });

  it("repo 레벨은 runnerGroup 무시(repo 러너엔 --runnergroup 무효)", async () => {
    const { runnerService, ciLinkService } = setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      { workspace: "acme", repository: "a/b", runnerGroup: "ignored", label: "y", apiUrl: "u" },
    );
    expect(res.installScript).not.toContain("--runnergroup");
  });

  it("repository 와 org 를 동시에/둘 다 미지정이면 BAD_REQUEST", async () => {
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
