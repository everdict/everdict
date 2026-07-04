import { describe, expect, it } from "vitest";
import { requiredCapabilities } from "./capability-requirements.js";
import type { EvalCase } from "./eval-case.js";

const base = (over: Partial<EvalCase>): EvalCase => ({
  id: "c",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
  ...over,
});

describe("requiredCapabilities — 케이스에서 실행 요구 파생(kind 별 레이어로)", () => {
  it("image 있으면 docker(functional), 없으면 안 붙음", () => {
    expect(requiredCapabilities(base({ image: "img:v1" }))).toContain("docker");
    expect(requiredCapabilities(base({}))).not.toContain("docker");
  });

  it("repo: files/path 소스는 git 불필요, 원격 git 소스만 git", () => {
    expect(requiredCapabilities(base({ env: { kind: "repo", source: { files: {} } } }))).not.toContain("git");
    expect(
      requiredCapabilities(base({ env: { kind: "repo", source: { git: "https://x/r.git", ref: "main" } } })),
    ).toContain("git");
  });

  it("browser → browser, os-use → computer-use, prompt → 없음", () => {
    expect(requiredCapabilities(base({ env: { kind: "browser" } }))).toEqual(["browser"]);
    expect(requiredCapabilities(base({ env: { kind: "os-use" } }))).toEqual(["computer-use"]);
    expect(requiredCapabilities(base({ env: { kind: "prompt" } }))).toEqual([]);
  });

  it("placement.isolation 있으면 sandbox(security — 강제는 trust-zone)", () => {
    expect(requiredCapabilities(base({ placement: { isolation: "gvisor" } }))).toContain("sandbox");
  });
});
