import type { AgentJob, CaseResult, RuntimeSpec } from "@assay/core";
import { describe, expect, it } from "vitest";
import type { Backend } from "./backend.js";
import { BackendRegistry, Router, buildRegistry, k8sRuntimeOptions, nomadRuntimeOptions } from "./registry.js";

class FakeBackend implements Backend {
  constructor(readonly id: string) {}
  async capacity() {
    return { total: 1, used: 0 };
  }
  async dispatch(_job: AgentJob): Promise<CaseResult> {
    return {
      caseId: "c",
      harness: this.id, // 어느 백엔드가 처리했는지 표시
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  }
}

function job(target?: string): AgentJob {
  return {
    harness: { id: "scripted", version: "0" },
    evalCase: {
      id: "c",
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 1,
      tags: [],
      ...(target ? { placement: { target } } : {}),
    },
  };
}

describe("Router", () => {
  const registry = new BackendRegistry().register("a", new FakeBackend("a")).register("b", new FakeBackend("b"));

  it("placement.target 으로 라우팅한다", async () => {
    expect((await new Router(registry, "a").dispatch(job("b"))).harness).toBe("b");
  });

  it("placement 가 없으면 default 백엔드로 간다", async () => {
    expect((await new Router(registry, "a").dispatch(job())).harness).toBe("a");
  });

  it("미등록 타깃은 에러", async () => {
    await expect(new Router(registry, "a").dispatch(job("missing"))).rejects.toThrow();
  });

  it("target 도 default 도 없으면 에러", async () => {
    await expect(new Router(registry).dispatch(job())).rejects.toThrow();
  });
});

describe("buildRegistry", () => {
  it("설정에서 여러 백엔드를 등록하고 default 를 돌려준다", () => {
    const { registry, defaultTarget } = buildRegistry({
      default: "nomad-a",
      backends: [
        { name: "dev", kind: "local" },
        { name: "nomad-a", kind: "nomad", addr: "http://a:4646", image: "img", runtime: "runsc" },
      ],
    });
    expect(registry.names().sort()).toEqual(["dev", "nomad-a"]);
    expect(defaultTarget).toBe("nomad-a");
  });
});

describe("nomadRuntimeOptions (외부 클러스터 API 인증)", () => {
  const spec = (authSecret?: string): Extract<RuntimeSpec, { kind: "nomad" }> => ({
    kind: "nomad",
    id: "rt",
    version: "1.0.0",
    tags: [],
    addr: "http://nomad:4646",
    image: "img",
    ...(authSecret ? { authSecret } : {}),
  });

  it("authSecret 을 API 토큰으로 풀고, alloc env 에서는 제외한다(클러스터 토큰 노출 금지)", () => {
    const opts = nomadRuntimeOptions(spec("NOMAD_TOKEN"), {
      NOMAD_TOKEN: "acl-xyz",
      ANTHROPIC_API_KEY: "sk-model",
    });
    expect(opts.apiToken).toBe("acl-xyz");
    expect(opts.secretEnv).toEqual({ ANTHROPIC_API_KEY: "sk-model" }); // 토큰은 빠지고 모델 키만 alloc 으로
  });

  it("authSecret 미지정이면 apiToken 없음 + secretEnv 그대로", () => {
    const opts = nomadRuntimeOptions(spec(), { ANTHROPIC_API_KEY: "sk-model" });
    expect(opts.apiToken).toBeUndefined();
    expect(opts.secretEnv).toEqual({ ANTHROPIC_API_KEY: "sk-model" });
  });
});

describe("k8sRuntimeOptions (외부 클러스터 API 인증)", () => {
  it("authSecret→bearer 토큰 + server 전달, alloc env 에서 토큰 제외", () => {
    const spec: Extract<RuntimeSpec, { kind: "k8s" }> = {
      kind: "k8s",
      id: "rt",
      version: "1.0.0",
      tags: [],
      image: "img",
      server: "https://k8s.acme.internal:6443",
      authSecret: "K8S_TOKEN",
    };
    const opts = k8sRuntimeOptions(spec, { K8S_TOKEN: "bearer-xyz", OPENAI_API_KEY: "sk-model" });
    expect(opts.apiToken).toBe("bearer-xyz");
    expect(opts.server).toBe("https://k8s.acme.internal:6443");
    expect(opts.secretEnv).toEqual({ OPENAI_API_KEY: "sk-model" });
  });

  it("kubeconfigSecret→전체 kubeconfig YAML 로 풀고, authSecret 과 함께 둘 다 alloc env 에서 제외", () => {
    const spec: Extract<RuntimeSpec, { kind: "k8s" }> = {
      kind: "k8s",
      id: "rt",
      version: "1.0.0",
      tags: [],
      image: "img",
      authSecret: "K8S_TOKEN",
      kubeconfigSecret: "KUBECONFIG_PROD",
    };
    const opts = k8sRuntimeOptions(spec, {
      K8S_TOKEN: "bearer-xyz",
      KUBECONFIG_PROD: "apiVersion: v1\nkind: Config\n",
      OPENAI_API_KEY: "sk-model",
    });
    expect(opts.kubeconfig).toBe("apiVersion: v1\nkind: Config\n");
    expect(opts.apiToken).toBe("bearer-xyz");
    // 클러스터 자격증명(토큰 + kubeconfig) 둘 다 제거 — 모델 키만 남는다(untrusted 에이전트에 클러스터 자격증명 노출 금지).
    expect(opts.secretEnv).toEqual({ OPENAI_API_KEY: "sk-model" });
  });
});
