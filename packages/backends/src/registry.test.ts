import type { AgentJob, CaseResult, RuntimeSpec } from "@everdict/core";
import { describe, expect, it } from "vitest";
import type { Backend } from "./backend.js";
import {
  BackendRegistry,
  Router,
  buildRegistry,
  buildRuntimeBackend,
  k8sRuntimeOptions,
  nomadRuntimeOptions,
} from "./registry.js";

class FakeBackend implements Backend {
  constructor(readonly id: string) {}
  async capacity() {
    return { total: 1, used: 0 };
  }
  async dispatch(_job: AgentJob): Promise<CaseResult> {
    return {
      caseId: "c",
      harness: this.id, // marks which backend handled it
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

  it("routes by placement.target", async () => {
    expect((await new Router(registry, "a").dispatch(job("b"))).harness).toBe("b");
  });

  it("goes to the default backend when there's no placement", async () => {
    expect((await new Router(registry, "a").dispatch(job())).harness).toBe("a");
  });

  it("an unregistered target is an error", async () => {
    await expect(new Router(registry, "a").dispatch(job("missing"))).rejects.toThrow();
  });

  it("no target and no default is an error", async () => {
    await expect(new Router(registry).dispatch(job())).rejects.toThrow();
  });
});

describe("buildRegistry", () => {
  it("registers multiple backends from config and returns the default", () => {
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

describe("buildRuntimeBackend (runtime defense after kind exhaustion)", () => {
  it("local/nomad/k8s build a backend", () => {
    expect(buildRuntimeBackend({ kind: "local", id: "a", version: "1.0.0", tags: [] })).toBeDefined();
    expect(
      buildRuntimeBackend({ kind: "nomad", id: "a", version: "1.0.0", tags: [], addr: "http://x:4646", image: "i" }),
    ).toBeDefined();
    expect(buildRuntimeBackend({ kind: "k8s", id: "a", version: "1.0.0", tags: [], image: "i" })).toBeDefined();
  });

  it("a kind outside the union (an unvalidated boundary value) is rejected as BAD_REQUEST — not a dead branch", () => {
    // After removing docker/topology, the union is local|nomad|k8s. If an unvalidated kind slips through the boundary, reject explicitly (never defense).
    const bogus = { kind: "topology", id: "a", version: "1.0.0", tags: [] } as unknown as RuntimeSpec;
    expect(() => buildRuntimeBackend(bogus)).toThrow(/BAD_REQUEST|topology/);
  });
});

describe("nomadRuntimeOptions (external cluster API auth)", () => {
  const spec = (authSecret?: string): Extract<RuntimeSpec, { kind: "nomad" }> => ({
    kind: "nomad",
    id: "rt",
    version: "1.0.0",
    tags: [],
    addr: "http://nomad:4646",
    image: "img",
    ...(authSecret ? { authSecret } : {}),
  });

  it("resolves authSecret to an API token and excludes it from the alloc env (no cluster-token exposure)", () => {
    const opts = nomadRuntimeOptions(spec("NOMAD_TOKEN"), {
      NOMAD_TOKEN: "acl-xyz",
      ANTHROPIC_API_KEY: "sk-model",
    });
    expect(opts.apiToken).toBe("acl-xyz");
    expect(opts.secretEnv).toEqual({ ANTHROPIC_API_KEY: "sk-model" }); // the token drops out; only the model key goes to the alloc
  });

  it("with no authSecret, no apiToken + secretEnv unchanged", () => {
    const opts = nomadRuntimeOptions(spec(), { ANTHROPIC_API_KEY: "sk-model" });
    expect(opts.apiToken).toBeUndefined();
    expect(opts.secretEnv).toEqual({ ANTHROPIC_API_KEY: "sk-model" });
  });
});

describe("k8sRuntimeOptions (external cluster API auth)", () => {
  it("authSecret→bearer token + passes server, excludes the token from the alloc env", () => {
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

  it("kubeconfigSecret→resolves to the full kubeconfig YAML, and both it and authSecret are excluded from the alloc env", () => {
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
    // Both cluster credentials (token + kubeconfig) removed — only the model key remains (never expose cluster credentials to an untrusted agent).
    expect(opts.secretEnv).toEqual({ OPENAI_API_KEY: "sk-model" });
  });
});
