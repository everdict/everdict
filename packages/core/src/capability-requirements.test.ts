import { describe, expect, it } from "vitest";
import { defaultRuntimeCapabilities, requiredCapabilities } from "./capability-requirements.js";
import type { EvalCase } from "./eval-case.js";
import type { RuntimeSpec } from "./runtime-spec.js";

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

describe("defaultRuntimeCapabilities — 등록 런타임이 제공하는 것 자동 라벨", () => {
  const rt = (over: Partial<RuntimeSpec> & { kind: RuntimeSpec["kind"] }): RuntimeSpec =>
    ({ id: "a", version: "1.0.0", tags: [], ...over }) as RuntimeSpec;

  it("nomad/k8s → docker; 하드닝 런타임 → sandbox; traceSource → topology; local → 없음", () => {
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x" }))).toEqual(["docker"]);
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x", runtimeClass: "gvisor" })).sort()).toEqual([
      "docker",
      "sandbox",
    ]);
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x", runtimeClass: "runc" }))).toEqual(["docker"]); // runc 는 하드닝 아님
    expect(
      defaultRuntimeCapabilities(
        rt({ kind: "nomad", addr: "http://x:4646", image: "x", traceSource: { kind: "otel", endpoint: "e" } }),
      ).sort(),
    ).toEqual(["docker", "topology"]);
    expect(defaultRuntimeCapabilities(rt({ kind: "local" }))).toEqual([]);
  });
});
