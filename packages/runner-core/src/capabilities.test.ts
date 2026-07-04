import { describe, expect, it } from "vitest";
import { type CapabilityProbes, detectCapabilities } from "./capabilities.js";

// 주입 프로브 — on 에 든 capability 만 지원하는 것으로 모사(실 OS 접근 없이 결정적 테스트).
const probes = (on: string[]): CapabilityProbes => ({
  git: async () => on.includes("git"),
  docker: async () => on.includes("docker"),
  browser: async () => on.includes("browser"),
  "computer-use": async () => on.includes("computer-use"),
  sandbox: async () => on.includes("sandbox"),
  "codex-login": async () => on.includes("codex-login"),
  "claude-login": async () => on.includes("claude-login"),
});

describe("detectCapabilities — 어휘 프로브 실측 → 지원 capability 만 자가-광고", () => {
  it("프로브가 통과한 capability 만 반환한다", async () => {
    expect(await detectCapabilities(probes(["git", "docker"]))).toEqual(["git", "docker"]);
    expect(await detectCapabilities(probes([]))).toEqual([]);
  });

  it("docker 배치 게이트 호환 — docker 있으면 반환에 docker 포함(runner-hub requiredRunnerCapabilities)", async () => {
    expect(await detectCapabilities(probes(["docker"]))).toContain("docker");
  });

  it("보안(sandbox)/인증(codex-login)도 실측 프로브로 라벨된다(강제는 별도 레이어)", async () => {
    const caps = await detectCapabilities(probes(["sandbox", "codex-login"]));
    expect([...caps].sort()).toEqual(["codex-login", "sandbox"]);
  });

  it("반환 순서는 어휘(CAPABILITY_DEFS) 순서다", async () => {
    // git 이 codex-login 보다 어휘에서 앞 → 입력 순서와 무관하게 어휘 순으로.
    expect(await detectCapabilities(probes(["codex-login", "git"]))).toEqual(["git", "codex-login"]);
  });
});
