import type { RuntimeSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { isInspectable, isProbeable, isReclaimable } from "../backend.js";
import { buildRuntimeBackend, k8sRuntimeOptions, nomadRuntimeOptions } from "./build-runtime-backend.js";

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

  // A topology-CONFIGURED runtime (nomad/k8s + traceSource) is still a plain cluster to probe/inspect/control — the
  // traceSource only adds service-topology DISPATCH behavior. buildRuntimeBackend ignores traceSource and builds the
  // base NomadBackend/K8sBackend, which ARE Probeable/Inspectable/Reclaimable. This is why apps/api routes the
  // cluster ops (probe/inspect/control) through buildRuntimeBackend, NOT the topology-routing runtimeBuildBackend
  // (whose ServiceTopologyBackend has none of these) — else they'd falsely report "not supported / no live cluster".
  it("a traceSource-configured nomad/k8s runtime still builds a Probeable + Inspectable + Reclaimable base backend", () => {
    const nomad = buildRuntimeBackend({
      kind: "nomad",
      id: "a",
      version: "1.0.0",
      tags: [],
      addr: "http://x:4646",
      image: "i",
      traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
    });
    expect(isProbeable(nomad)).toBe(true);
    expect(isInspectable(nomad)).toBe(true);
    expect(isReclaimable(nomad)).toBe(true);

    const k8s = buildRuntimeBackend({
      kind: "k8s",
      id: "a",
      version: "1.0.0",
      tags: [],
      image: "i",
      traceSource: { kind: "otel", endpoint: "http://otel:4318" },
    });
    expect(isProbeable(k8s)).toBe(true);
    expect(isInspectable(k8s)).toBe(true);
    expect(isReclaimable(k8s)).toBe(true);
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
