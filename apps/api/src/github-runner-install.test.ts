import { InMemoryConnectionStore, InMemoryRunnerStore, InMemoryWorkspaceSettingsStore, aesGcmCipher } from "@assay/db";
import { describe, expect, it } from "vitest";
import { CiLinkService } from "./ci-link-service.js";
import { installGithubWorkspaceRunner } from "./github-runner-install.js";
import { RunnerService } from "./runner-service.js";

const cipher = aesGcmCipher(Buffer.alloc(32, 1));

function ghFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/actions/runners/registration-token") && init?.method === "POST")
      return new Response(JSON.stringify({ token: "REG-TOKEN", expires_at: "2026-07-04T12:00:00Z" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
}

async function setup() {
  const connections = new InMemoryConnectionStore(cipher);
  const conn = await connections.create({
    owner: "alice",
    workspace: "acme",
    provider: "github",
    accountLabel: "alice-gh",
    scopes: ["repo"],
    accessToken: "gho_x",
  });
  const ciLinkService = new CiLinkService({
    settings: new InMemoryWorkspaceSettingsStore(),
    connections,
    fetchImpl: ghFetch(),
  });
  const runnerStore = new InMemoryRunnerStore();
  const runnerService = new RunnerService(runnerStore);
  return { runnerService, ciLinkService, runnerStore, connectionId: conn.id };
}

describe("installGithubWorkspaceRunner — GitHub Actions 러너 자가등록(빌드 서버에 두 워커)", () => {
  it("워크스페이스-공유 러너 페어링 + GitHub 등록 토큰 mint + 설치 스크립트/워크플로 힌트 생성", async () => {
    const { runnerService, ciLinkService, runnerStore, connectionId } = await setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      {
        workspace: "acme",
        subject: "alice",
        connectionId,
        repository: "acme/app",
        label: "acme-ci",
        apiUrl: "https://assay.example.com",
        capabilities: ["git", "docker"],
      },
    );

    // 워크스페이스-공유 러너로 페어링됨(owner=ws:acme) → self:ws:<id> 로 타깃.
    expect(res.runtimeTarget).toBe(`self:ws:${res.runner.id}`);
    expect(res.githubRunnerLabel).toBe(`assay-${res.runner.id}`);
    expect(res.registrationExpiresAt).toBe("2026-07-04T12:00:00Z");
    const owned = await runnerStore.list("ws:acme");
    expect(owned.map((r) => r.id)).toContain(res.runner.id);

    // 설치 스크립트: GitHub 러너(config.sh + 등록 토큰) + Assay 러너(assay runner --pair + rnr_ 토큰) 둘 다.
    expect(res.installScript).toContain("./config.sh");
    expect(res.installScript).toContain("https://github.com/acme/app");
    expect(res.installScript).toContain("REG-TOKEN");
    expect(res.installScript).toContain("assay runner --pair");
    expect(res.installScript).toContain("--api-url \"https://assay.example.com\"");
    expect(res.installScript).toMatch(/rnr_/); // 페어링 평문 토큰이 스크립트에 실림

    // 워크플로 힌트: runs-on 라벨 + run-eval runtime 입력.
    expect(res.workflowHint).toContain(`self-hosted, assay-${res.runner.id}`);
    expect(res.workflowHint).toContain(`runtime: self:ws:${res.runner.id}`);
  });

  it("repository 형식이 'owner/name' 이 아니면 BAD_REQUEST(페어링 전에 거절)", async () => {
    const { runnerService, ciLinkService, runnerStore, connectionId } = await setup();
    await expect(
      installGithubWorkspaceRunner(
        { runnerService, ciLinkService },
        { workspace: "acme", subject: "alice", connectionId, repository: "not-a-repo", label: "x", apiUrl: "u" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await runnerStore.list("ws:acme")).toHaveLength(0); // 잘못된 입력에 러너를 만들지 않음
  });

  it("org 레벨(org 지정): config.sh --url 가 org URL(그 org 의 모든 레포 공유)", async () => {
    const { runnerService, ciLinkService, connectionId } = await setup();
    const res = await installGithubWorkspaceRunner(
      { runnerService, ciLinkService },
      { workspace: "acme", subject: "alice", connectionId, org: "acme-org", label: "org-ci", apiUrl: "https://a.example.com" },
    );
    expect(res.installScript).toContain("https://github.com/acme-org")
    expect(res.installScript).not.toContain("https://github.com/acme-org/") // repo 경로 아님(org URL 그대로)
    expect(res.runtimeTarget).toBe(`self:ws:${res.runner.id}`)
  });

  it("repository 와 org 를 동시에/둘 다 미지정이면 BAD_REQUEST", async () => {
    const { runnerService, ciLinkService, connectionId } = await setup();
    await expect(
      installGithubWorkspaceRunner(
        { runnerService, ciLinkService },
        { workspace: "acme", subject: "alice", connectionId, repository: "a/b", org: "a", label: "x", apiUrl: "u" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      installGithubWorkspaceRunner(
        { runnerService, ciLinkService },
        { workspace: "acme", subject: "alice", connectionId, label: "x", apiUrl: "u" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
