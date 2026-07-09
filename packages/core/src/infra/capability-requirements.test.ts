import { describe, expect, it } from "vitest";
import type { EvalCase } from "../execution/eval-case.js";
import { defaultRuntimeCapabilities, requiredCapabilities } from "./capability-requirements.js";
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

describe("requiredCapabilities — derive execution requirements from the case (routed per kind)", () => {
  it("adds docker (functional) when image is present, omits it otherwise", () => {
    expect(requiredCapabilities(base({ image: "img:v1" }))).toContain("docker");
    expect(requiredCapabilities(base({}))).not.toContain("docker");
  });

  it("repo: files/path sources don't need git, only a remote git source does", () => {
    expect(requiredCapabilities(base({ env: { kind: "repo", source: { files: {} } } }))).not.toContain("git");
    expect(
      requiredCapabilities(base({ env: { kind: "repo", source: { git: "https://x/r.git", ref: "main" } } })),
    ).toContain("git");
  });

  it("browser → browser, os-use → computer-use, prompt → none", () => {
    expect(requiredCapabilities(base({ env: { kind: "browser" } }))).toEqual(["browser"]);
    expect(requiredCapabilities(base({ env: { kind: "os-use" } }))).toEqual(["computer-use"]);
    expect(requiredCapabilities(base({ env: { kind: "prompt" } }))).toEqual([]);
  });

  it("adds sandbox when placement.isolation is set (security — enforced by trust-zone)", () => {
    expect(requiredCapabilities(base({ placement: { isolation: "gvisor" } }))).toContain("sandbox");
  });
});

describe("defaultRuntimeCapabilities — auto-label what a registered runtime provides", () => {
  const rt = (over: Partial<RuntimeSpec> & { kind: RuntimeSpec["kind"] }): RuntimeSpec =>
    ({ id: "a", version: "1.0.0", tags: [], ...over }) as RuntimeSpec;

  it("nomad/k8s → docker; hardened runtime → sandbox; traceSource → topology; local → none", () => {
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x" }))).toEqual(["docker"]);
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x", runtimeClass: "gvisor" })).sort()).toEqual([
      "docker",
      "sandbox",
    ]);
    expect(defaultRuntimeCapabilities(rt({ kind: "k8s", image: "x", runtimeClass: "runc" }))).toEqual(["docker"]); // runc is not hardened
    expect(
      defaultRuntimeCapabilities(
        rt({ kind: "nomad", addr: "http://x:4646", image: "x", traceSource: { kind: "otel", endpoint: "e" } }),
      ).sort(),
    ).toEqual(["docker", "topology"]);
    expect(defaultRuntimeCapabilities(rt({ kind: "local" }))).toEqual([]);
  });
});
