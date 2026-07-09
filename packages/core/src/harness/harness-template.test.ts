import { describe, expect, it } from "vitest";
import { BadRequestError } from "../errors.js";
import {
  HarnessInstanceSpecSchema,
  type HarnessTemplateSpec,
  HarnessTemplateSpecSchema,
  resolveHarnessInstance,
} from "./harness-template.js";

// service template (category): service structure only, no images (slot).
const buTemplate: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
  kind: "service",
  category: "topology",
  id: "bu",
  version: "1",
  services: [
    { name: "planner", needs: [] },
    { name: "browser" },
    { name: "action-stream", needs: ["redis"], slot: "action" },
  ],
  dependencies: [{ store: "redis", role: "bus", isolateBy: "key-prefix" }],
  frontDoor: { service: "planner", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
});

describe("resolveHarnessInstance — service(topology)", () => {
  it("template structure + instance pins → resolved ServiceHarnessSpec (slots substituted with images)", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "pr-123-sha-abc",
      pins: { planner: "ghcr.io/acme/planner:abc", browser: "chromedp/headless-shell:119", action: "reg/action:abc" },
    });
    const resolved = resolveHarnessInstance(buTemplate, instance);
    expect(resolved.kind).toBe("service");
    expect(resolved.id).toBe("bu");
    expect(resolved.version).toBe("pr-123-sha-abc");
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.map((s) => [s.name, s.image])).toEqual([
      ["planner", "ghcr.io/acme/planner:abc"],
      ["browser", "chromedp/headless-shell:119"],
      ["action-stream", "reg/action:abc"], // pinned via slot 'action'
    ]);
    expect(resolved.dependencies).toHaveLength(1);
    expect(resolved.frontDoor.service).toBe("planner");
  });

  it("service env is preserved through to the resolved spec (not overwritten by default {})", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "e",
      version: "1",
      services: [{ name: "planner", needs: [], env: { LOG_LEVEL: "debug", MODEL: "x" } }],
      dependencies: [],
      frontDoor: { service: "planner", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "e", version: "1" },
      id: "e",
      version: "v1",
      pins: { planner: "p:1" },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services[0]?.env).toEqual({ LOG_LEVEL: "debug", MODEL: "x" });
  });

  it("service volumes/readiness are preserved through to the resolved spec (so the runtime can interpret them)", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "v",
      version: "1",
      services: [
        {
          name: "db",
          needs: [],
          volumes: ["pgdata:/var/lib/postgresql/data", "/host/seed:/seed:ro"],
          readiness: { timeoutMs: 120000, intervalMs: 2000 },
        },
      ],
      dependencies: [],
      frontDoor: { service: "db", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "v", version: "1" },
      id: "v",
      version: "v1",
      pins: { db: "postgres:16" },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services[0]?.volumes).toEqual(["pgdata:/var/lib/postgresql/data", "/host/seed:/seed:ro"]);
    expect(resolved.services[0]?.readiness).toEqual({ timeoutMs: 120000, intervalMs: 2000 });
  });

  it("external(BYO) dependency + service is preserved through to the resolved spec", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "x",
      version: "1",
      services: [{ name: "planner", needs: [] }],
      dependencies: [{ store: "redis", role: "cache", isolateBy: "external", service: "planner" }],
      frontDoor: { service: "planner", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "x", version: "1" },
      id: "x",
      version: "v1",
      pins: { planner: "p:1" },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.dependencies[0]).toEqual({
      store: "redis",
      role: "cache",
      isolateBy: "external",
      service: "planner",
    });
  });

  it("overrides.services[].env is merged on top of the template env (instance variation — same image, different behavior)", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "ov",
      version: "1",
      services: [{ name: "planner", needs: [], env: { LOG_LEVEL: "info", MODEL: "base" } }],
      dependencies: [],
      frontDoor: { service: "planner", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "ov", version: "1" },
      id: "ov",
      version: "opus-temp02",
      pins: { planner: "p:1" },
      overrides: { services: { planner: { env: { MODEL: "claude-opus-4-8", TEMPERATURE: "0.2" } } } },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    // MODEL is overridden by the instance, LOG_LEVEL is kept from the template, TEMPERATURE is added.
    expect(resolved.services[0]?.env).toEqual({ LOG_LEVEL: "info", MODEL: "claude-opus-4-8", TEMPERATURE: "0.2" });
  });

  it("overrides.frontDoor.request.bodyTemplate is shallow-merged on top of the template body", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "fd",
      version: "1",
      services: [{ name: "planner", needs: [] }],
      dependencies: [],
      frontDoor: {
        service: "planner",
        submit: "POST /runs",
        request: { bodyTemplate: { task: "{{task}}", max_steps: 10 } },
      },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "fd", version: "1" },
      id: "fd",
      version: "deep",
      pins: { planner: "p:1" },
      overrides: { frontDoor: { request: { bodyTemplate: { max_steps: 30 } } } },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.frontDoor.request?.bodyTemplate).toEqual({ task: "{{task}}", max_steps: 30 });
  });

  it("overrides.services[]'s replicas/resources/volumes/readiness are scalar-substituted (Phase 2/3)", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "r",
      version: "1",
      services: [{ name: "planner", needs: [], replicas: 1, readiness: { timeoutMs: 60000, intervalMs: 1000 } }],
      dependencies: [],
      frontDoor: { service: "planner", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "r", version: "1" },
      id: "r",
      version: "big",
      pins: { planner: "p:1" },
      overrides: {
        services: {
          planner: {
            replicas: 3,
            resources: { cpu: 2000, memoryMb: 4096 },
            volumes: ["cache:/cache"],
            readiness: { timeoutMs: 120000, intervalMs: 2000 },
          },
        },
      },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    const s = resolved.services[0];
    expect(s?.replicas).toBe(3);
    expect(s?.resources).toEqual({ cpu: 2000, memoryMb: 4096 });
    expect(s?.volumes).toEqual(["cache:/cache"]);
    expect(s?.readiness).toEqual({ timeoutMs: 120000, intervalMs: 2000 });
  });

  it("overrides.target.extension.ref pins the template target's extension, and BadRequest if no target (Phase 3)", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "t",
      version: "1",
      services: [{ name: "planner", needs: [] }],
      dependencies: [],
      target: { kind: "browser", engine: "chromium" },
      frontDoor: { service: "planner", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "t", version: "1" },
      id: "t",
      version: "ext2",
      pins: { planner: "p:1" },
      overrides: { target: { extension: { ref: "ghcr.io/acme/ext:2" } } },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.target?.extension?.ref).toBe("ghcr.io/acme/ext:2");

    // target override on a template without a target → BadRequest
    const noTarget = HarnessTemplateSpecSchema.parse({ ...tpl, target: undefined });
    expect(() => resolveHarnessInstance(noTarget, instance)).toThrow(BadRequestError);
  });

  it("overrides.frontDoor.completion timing is merged on top of the template completion and mode-mismatched keys are dropped (Phase 3)", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "c",
      version: "1",
      services: [{ name: "planner", needs: [] }],
      dependencies: [],
      frontDoor: {
        service: "planner",
        submit: "POST /runs",
        completion: { mode: "poll", statusPath: "GET /runs/{run_id}", done: { field: "status", equals: "done" } },
      },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "c", version: "1" },
      id: "c",
      version: "slow",
      pins: { planner: "p:1" },
      overrides: { frontDoor: { completion: { timeoutMs: 300000, intervalMs: 5000 } } },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    const c = resolved.frontDoor.completion;
    if (c?.mode !== "poll") throw new Error("expected poll");
    expect(c.timeoutMs).toBe(300000);
    expect(c.intervalMs).toBe(5000);
    expect(c.statusPath).toBe("GET /runs/{run_id}"); // mode/structure are preserved
  });

  it("BadRequestError when the override target service is not in the template", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "x",
      pins: { planner: "p", browser: "b", action: "a" },
      overrides: { services: { nope: { env: { X: "1" } } } },
    });
    expect(() => resolveHarnessInstance(buTemplate, instance)).toThrow(BadRequestError);
  });

  it("missing slot pin → BadRequestError", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "x",
      pins: { planner: "p:1", browser: "b:1" }, // action missing
    });
    expect(() => resolveHarnessInstance(buTemplate, instance)).toThrow(BadRequestError);
  });

  it("instance's template reference mismatches the template → BadRequestError", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "2" }, // version mismatch
      id: "bu",
      version: "x",
      pins: { planner: "p", browser: "b", action: "a" },
    });
    expect(() => resolveHarnessInstance(buTemplate, instance)).toThrow(BadRequestError);
  });
});

describe("resolveHarnessInstance — command", () => {
  const cmdTemplate: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
    kind: "command",
    category: "aider",
    id: "aider",
    version: "1",
    image: "python:3.12",
    setup: ["pip install aider-chat==0.74.0"],
    command: "aider --yes --message {{task}} --model {{model}} .",
    model: "gpt-4o",
  });

  it("pins.image/model override the template defaults", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "aider", version: "1" },
      id: "aider",
      version: "sha-def",
      pins: { image: "ghcr.io/acme/aider:def", model: "claude-opus-4-8" },
    });
    const resolved = resolveHarnessInstance(cmdTemplate, instance);
    if (resolved.kind !== "command") throw new Error("expected command");
    expect(resolved.image).toBe("ghcr.io/acme/aider:def");
    expect(resolved.model).toBe("claude-opus-4-8");
    expect(resolved.command).toContain("aider --yes");
  });

  it("uses template defaults when pins are empty", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "aider", version: "1" },
      id: "aider",
      version: "sha-000",
    });
    const resolved = resolveHarnessInstance(cmdTemplate, instance);
    if (resolved.kind !== "command") throw new Error("expected command");
    expect(resolved.image).toBe("python:3.12");
    expect(resolved.model).toBe("gpt-4o");
  });

  it("overrides.env/params are merged on top of the template (same command, different flag variation)", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "command",
      category: "aider",
      id: "aider",
      version: "1",
      command: "aider --message {{task}} --model {{model}} --edit-format {{edit_format}} .",
      env: { AIDER_YES: "1" },
      params: { edit_format: "whole" },
      model: "gpt-4o",
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "aider", version: "1" },
      id: "aider",
      version: "diff-mode",
      overrides: { env: { AIDER_TEMPERATURE: "0" }, params: { edit_format: "diff" } },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "command") throw new Error("expected command");
    expect(resolved.env).toEqual({ AIDER_YES: "1", AIDER_TEMPERATURE: "0" });
    expect(resolved.params).toEqual({ edit_format: "diff" }); // the instance overrides the template default
  });
});

describe("HarnessInstanceSpec — description (version changelog)", () => {
  it("a free-text description (changelog) can be attached to the instance and is preserved on parse", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "aider", version: "1" },
      id: "aider",
      version: "sha-def",
      pins: { image: "ghcr.io/acme/aider:def" },
      description: "add flag to auto-approve the approval prompt",
    });
    expect(instance.description).toBe("add flag to auto-approve the approval prompt");
  });

  it("description is optional — runtime-agnostic meta, so it is not carried into the resolved spec", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "process",
      category: "claude-code",
      id: "claude-code",
      version: "1",
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "claude-code", version: "1" },
      id: "claude-code",
      version: "2026.06",
      description: "note",
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    expect("description" in resolved).toBe(false);
  });
});

describe("resolveHarnessInstance — process", () => {
  it("process template → resolved ProcessHarnessSpec(id@version)", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "process",
      category: "claude-code",
      id: "claude-code",
      version: "1",
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "claude-code", version: "1" },
      id: "claude-code",
      version: "2026.06",
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    expect(resolved).toEqual({ kind: "process", id: "claude-code", version: "2026.06" });
  });
});
