import {
  CommandHarnessSpecSchema,
  type HarnessSpec,
  K8sRuntimeSpecSchema,
  ModelSpecSchema,
  NomadRuntimeSpecSchema,
  type RuntimeSpec,
  ServiceHarnessSpecSchema,
  WorkspaceSettingsSchema,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { collectSecretUsages } from "./secret-usage.js";

// Small helpers — parse minimal valid specs so the fixtures can't drift from the schemas.
const harness = (id: string, spec: HarnessSpec) => ({ id, version: spec.version, spec });
const commandHarness = (
  id: string,
  extra: Record<string, unknown>,
): { id: string; version: string; spec: HarnessSpec } =>
  harness(id, CommandHarnessSpecSchema.parse({ kind: "command", id, version: "1.0.0", command: "run", ...extra }));

const runtime = (id: string, spec: RuntimeSpec) => ({ id, version: spec.version, spec });

describe("collectSecretUsages", () => {
  it("returns nothing for empty inputs", () => {
    expect(collectSecretUsages({ harnesses: [], runtimes: [], models: [] })).toEqual([]);
  });

  it("scans command-harness env references keyed by their own scope", () => {
    const usages = collectSecretUsages({
      harnesses: [
        commandHarness("aider", {
          env: {
            OPENAI_API_KEY: { secretRef: "OPENAI_API_KEY" }, // default scope = workspace
            PRIVATE_TOKEN: { secretRef: "MY_TOKEN", scope: "user" },
            LITERAL: "not-a-secret",
          },
        }),
      ],
      runtimes: [],
      models: [],
    });
    expect(usages).toContainEqual({
      name: "OPENAI_API_KEY",
      scope: "workspace",
      ref: {
        kind: "harness",
        label: "aider",
        resourceId: "aider",
        version: "1.0.0",
        field: "env",
        detail: "OPENAI_API_KEY",
      },
    });
    expect(usages).toContainEqual({
      name: "MY_TOKEN",
      scope: "user",
      ref: {
        kind: "harness",
        label: "aider",
        resourceId: "aider",
        version: "1.0.0",
        field: "env",
        detail: "PRIVATE_TOKEN",
      },
    });
    // Literal env values never produce a usage.
    expect(usages.some((u) => u.name === "not-a-secret")).toBe(false);
  });

  it("scans a command-harness trace auth secret", () => {
    const usages = collectSecretUsages({
      harnesses: [
        commandHarness("codex", { trace: { kind: "mlflow", endpoint: "http://mlflow", authSecret: "MLFLOW_TOKEN" } }),
      ],
      runtimes: [],
      models: [],
    });
    expect(usages).toContainEqual({
      name: "MLFLOW_TOKEN",
      scope: "workspace",
      ref: { kind: "harness", label: "codex", resourceId: "codex", version: "1.0.0", field: "trace-auth" },
    });
  });

  it("scans service-harness per-service env + trace-source auth", () => {
    const spec = ServiceHarnessSpecSchema.parse({
      kind: "service",
      id: "browser-use",
      version: "2.0.0",
      services: [{ name: "agent", image: "agent:1", env: { API_KEY: { secretRef: "SHARED_KEY" } } }],
      frontDoor: { service: "agent", submit: "/submit" },
      traceSource: { kind: "otel", endpoint: "http://otel", authSecret: "OTEL_TOKEN" },
    });
    const usages = collectSecretUsages({ harnesses: [harness("browser-use", spec)], runtimes: [], models: [] });
    expect(usages).toContainEqual({
      name: "SHARED_KEY",
      scope: "workspace",
      ref: {
        kind: "harness",
        label: "browser-use",
        resourceId: "browser-use",
        version: "2.0.0",
        field: "env",
        detail: "agent:API_KEY",
      },
    });
    expect(usages).toContainEqual({
      name: "OTEL_TOKEN",
      scope: "workspace",
      ref: { kind: "harness", label: "browser-use", resourceId: "browser-use", version: "2.0.0", field: "trace-auth" },
    });
  });

  it("scans runtime cluster tokens, kubeconfig, and topology trace auth", () => {
    const nomad = NomadRuntimeSpecSchema.parse({
      kind: "nomad",
      id: "prod",
      version: "1.0.0",
      addr: "http://nomad:4646",
      image: "runner:1",
      authSecret: "NOMAD_TOKEN",
      traceSource: { kind: "otel", endpoint: "http://otel", authSecret: "RT_OTEL_TOKEN" },
    });
    const k8s = K8sRuntimeSpecSchema.parse({
      kind: "k8s",
      id: "eks",
      version: "1.0.0",
      image: "runner:1",
      kubeconfigSecret: "KUBECONFIG",
    });
    const usages = collectSecretUsages({
      harnesses: [],
      runtimes: [runtime("prod", nomad), runtime("eks", k8s)],
      models: [],
    });
    expect(usages).toContainEqual({
      name: "NOMAD_TOKEN",
      scope: "workspace",
      ref: { kind: "runtime", label: "prod", resourceId: "prod", version: "1.0.0", field: "cluster-token" },
    });
    expect(usages).toContainEqual({
      name: "RT_OTEL_TOKEN",
      scope: "workspace",
      ref: { kind: "runtime", label: "prod", resourceId: "prod", version: "1.0.0", field: "trace-auth" },
    });
    expect(usages).toContainEqual({
      name: "KUBECONFIG",
      scope: "workspace",
      ref: { kind: "runtime", label: "eks", resourceId: "eks", version: "1.0.0", field: "kubeconfig" },
    });
  });

  it("resolves a model's api-key secret — explicit name and provider default", () => {
    const explicit = ModelSpecSchema.parse({
      id: "gpt",
      version: "1.0.0",
      provider: "openai",
      model: "gpt-5",
      apiKeySecret: "MY_OPENAI",
    });
    const bare = ModelSpecSchema.parse({
      id: "claude",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    const usages = collectSecretUsages({
      harnesses: [],
      runtimes: [],
      models: [
        { id: "gpt", version: "1.0.0", spec: explicit },
        { id: "claude", version: "1.0.0", spec: bare },
      ],
    });
    expect(usages).toContainEqual({
      name: "MY_OPENAI",
      scope: "workspace",
      ref: { kind: "model", label: "gpt", resourceId: "gpt", version: "1.0.0", field: "api-key" },
    });
    // No explicit apiKeySecret → the provider default (ANTHROPIC_API_KEY) is what the model actually uses.
    expect(usages).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      scope: "workspace",
      ref: { kind: "model", label: "claude", resourceId: "claude", version: "1.0.0", field: "api-key" },
    });
  });

  it("scans workspace-settings integrations (mattermost, image registries, trace sources, proxies)", () => {
    const settings = WorkspaceSettingsSchema.parse({
      mattermost: { host: "https://mm.acme.io", botTokenSecretName: "MM_BOT", commandTokenSecretName: "MM_CMD" },
      imageRegistries: [{ name: "ghcr", host: "ghcr.io", pullSecretName: "GHCR_PULL", pushSecretName: "GHCR_PUSH" }],
      traceSources: [
        { name: "mlflow-prod", kind: "mlflow", endpoint: "https://mlflow.acme.io", authSecretName: "TS_AUTH" },
      ],
      proxies: [{ name: "us-proxy", country: "US", url: "http://proxy.acme.io:8080", authSecretName: "PROXY_AUTH" }],
    });
    const usages = collectSecretUsages({ harnesses: [], runtimes: [], models: [], settings });
    const names = usages.map((u) => u.name);
    expect(names).toEqual(
      expect.arrayContaining(["MM_BOT", "MM_CMD", "GHCR_PULL", "GHCR_PUSH", "TS_AUTH", "PROXY_AUTH"]),
    );
    expect(usages).toContainEqual({
      name: "GHCR_PUSH",
      scope: "workspace",
      ref: { kind: "imageRegistry", label: "ghcr", field: "registry-push" },
    });
    expect(usages).toContainEqual({
      name: "PROXY_AUTH",
      scope: "workspace",
      ref: { kind: "proxy", label: "us-proxy", field: "proxy-auth" },
    });
  });

  it("falls back to the legacy singular image registry + legacy trace sinks", () => {
    const settings = WorkspaceSettingsSchema.parse({
      imageRegistry: { host: "ghcr.io", pushSecretName: "LEGACY_PUSH" },
      traceSinks: [
        { name: "sink", kind: "langfuse", endpoint: "https://lf.acme.io", authSecretName: "LEGACY_SINK_AUTH" },
      ],
    });
    const usages = collectSecretUsages({ harnesses: [], runtimes: [], models: [], settings });
    expect(usages).toContainEqual({
      name: "LEGACY_PUSH",
      scope: "workspace",
      ref: { kind: "imageRegistry", label: "default", field: "registry-push" },
    });
    expect(usages).toContainEqual({
      name: "LEGACY_SINK_AUTH",
      scope: "workspace",
      ref: { kind: "traceSource", label: "sink", field: "trace-auth" },
    });
  });
});
