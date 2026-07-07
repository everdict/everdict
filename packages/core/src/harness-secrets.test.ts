import { describe, expect, it } from "vitest";
import { BadRequestError } from "./errors.js";
import { flattenEnv, referencesUserSecret, resolveHarnessSecrets } from "./harness-secrets.js";
import { CommandHarnessSpecSchema, ServiceHarnessSpecSchema } from "./harness-spec.js";

describe("flattenEnv", () => {
  it("passes literals through and resolves refs from lookup", () => {
    const out = flattenEnv(
      { LOG_LEVEL: "debug", OPENAI_API_KEY: { secretRef: "OPENAI_API_KEY" } },
      { OPENAI_API_KEY: "sk-live" },
    );
    expect(out).toEqual({ LOG_LEVEL: "debug", OPENAI_API_KEY: "sk-live" });
  });

  it("drops unresolved refs (no lookup entry) — never emits [object Object]", () => {
    const out = flattenEnv({ A: "1", MISSING: { secretRef: "NOPE" } });
    expect(out).toEqual({ A: "1" });
  });
});

describe("resolveHarnessSecrets", () => {
  const commandSpec = CommandHarnessSpecSchema.parse({
    kind: "command",
    id: "aider",
    version: "1.0.0",
    command: "aider --message {{task}}",
    env: {
      EDITOR: "vim",
      ANTHROPIC_API_KEY: { secretRef: "ANTHROPIC_API_KEY" },
      MY_KEY: { secretRef: "MY_KEY", scope: "user" },
    },
  });

  it("resolves workspace and user refs from their own tiers; literals untouched", () => {
    const resolved = resolveHarnessSecrets(commandSpec, {
      workspace: { ANTHROPIC_API_KEY: "sk-ant" },
      user: { MY_KEY: "personal" },
    });
    if (resolved.kind !== "command") throw new Error("unreachable");
    expect(resolved.env).toEqual({ EDITOR: "vim", ANTHROPIC_API_KEY: "sk-ant", MY_KEY: "personal" });
  });

  it("does NOT resolve a user ref from the workspace tier", () => {
    try {
      resolveHarnessSecrets(commandSpec, { workspace: { ANTHROPIC_API_KEY: "sk-ant", MY_KEY: "leak" } });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).message).toContain("user:MY_KEY");
    }
  });

  it("throws BadRequestError listing missing referenced secrets", () => {
    try {
      resolveHarnessSecrets(commandSpec, { workspace: {}, user: {} });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("resolves trace.authSecret(name) to the workspace secret value and loads it into transient trace.auth (in-job pull auth)", () => {
    const spec = CommandHarnessSpecSchema.parse({
      kind: "command",
      id: "cli",
      version: "1.0.0",
      command: "run",
      env: {},
      trace: { kind: "mlflow", endpoint: "http://m", authSecret: "MLFLOW_AUTH" },
    });
    const resolved = resolveHarnessSecrets(spec, { workspace: { MLFLOW_AUTH: "Basic abc" } });
    if (resolved.kind !== "command" || resolved.trace.kind !== "mlflow") throw new Error("expected command/mlflow");
    expect(resolved.trace.auth).toBe("Basic abc"); // value only in the job payload (transient) — the registry spec keeps only the name
    expect(resolved.trace.authSecret).toBe("MLFLOW_AUTH");
  });

  it("throws BadRequestError (explicit failure) when trace.authSecret is unregistered, same as an env secret", () => {
    const spec = CommandHarnessSpecSchema.parse({
      kind: "command",
      id: "cli",
      version: "1.0.0",
      command: "run",
      env: {},
      trace: { kind: "otel", endpoint: "http://j", authSecret: "OTEL_AUTH" },
    });
    try {
      resolveHarnessSecrets(spec, { workspace: {} });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).message).toContain("OTEL_AUTH");
    }
  });

  it("resolves each service's env for service harnesses", () => {
    const serviceSpec = ServiceHarnessSpecSchema.parse({
      kind: "service",
      id: "bu",
      version: "1.0.0",
      services: [
        {
          name: "agent",
          image: "ghcr.io/x/agent:1",
          env: { PORT: "8080", HF_TOKEN: { secretRef: "HF_TOKEN" } },
        },
      ],
      frontDoor: { service: "agent", submit: "POST /runs" },
      traceSource: { kind: "mlflow", endpoint: "http://mlflow:5501" },
    });
    const resolved = resolveHarnessSecrets(serviceSpec, { workspace: { HF_TOKEN: "hf_abc" } });
    if (resolved.kind !== "service") throw new Error("unreachable");
    expect(resolved.services[0]?.env).toEqual({ PORT: "8080", HF_TOKEN: "hf_abc" });
  });

  it("leaves process harnesses unchanged", () => {
    const spec = { kind: "process", id: "cc", version: "1.0.0" } as const;
    expect(resolveHarnessSecrets(spec, { workspace: {} })).toBe(spec);
  });
});

describe("referencesUserSecret", () => {
  it("true when any command env ref is user-scoped", () => {
    const spec = CommandHarnessSpecSchema.parse({
      kind: "command",
      id: "x",
      version: "1.0.0",
      command: "run",
      env: { A: "lit", K: { secretRef: "K", scope: "user" } },
    });
    expect(referencesUserSecret(spec)).toBe(true);
  });

  it("false when only literals and workspace refs are present", () => {
    const spec = CommandHarnessSpecSchema.parse({
      kind: "command",
      id: "x",
      version: "1.0.0",
      command: "run",
      env: { A: "lit", K: { secretRef: "K" }, W: { secretRef: "W", scope: "workspace" } },
    });
    expect(referencesUserSecret(spec)).toBe(false);
  });
});
