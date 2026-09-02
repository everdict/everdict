import { describe, expect, it } from "vitest";
import { BadRequestError } from "../errors.js";
import { caseTokenDefects, harnessResourcesOf, targetDefects } from "./harness-spec.js";
import {
  HarnessInstanceSpecSchema,
  type HarnessTemplateSpec,
  HarnessTemplateSpecSchema,
  resolveDelegate,
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
  dependencies: [{ store: "redis", role: "bus", purpose: "plumbing", isolateBy: "key-prefix" }],
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

  it("service requires/wiring/model are preserved through to the resolved spec (placement + peer wiring + model binding)", () => {
    // Regression: the resolve rebuilt services from an allowlist and DROPPED these — a requires.os=windows
    // topology lost its OS requirement, so the lease-time placement gate let any Linux runner take it.
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "w",
      version: "1",
      services: [
        {
          name: "client",
          needs: ["relay"],
          requires: { os: "windows" },
          wiring: [{ service: "relay", urlEnv: "RELAY_URL" }],
          model: "gpt-5-codex",
        },
        { name: "relay", needs: [], port: 8001 },
      ],
      dependencies: [],
      frontDoor: { service: "relay", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "w", version: "1" },
      id: "w",
      version: "v1",
      pins: { client: "win-client:1", relay: "relay:1" },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    const client = resolved.services.find((s) => s.name === "client");
    expect(client?.requires).toEqual({ os: "windows" });
    expect(client?.wiring).toEqual([{ service: "relay", urlEnv: "RELAY_URL" }]);
    expect(client?.model).toBe("gpt-5-codex");
  });

  it("external(BYO) dependency + service is preserved through to the resolved spec", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "x",
      version: "1",
      services: [{ name: "planner", needs: [] }],
      dependencies: [{ store: "redis", role: "cache", purpose: "plumbing", isolateBy: "external", service: "planner" }],
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
      purpose: "plumbing",
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
    expect(resolved.target?.kind === "browser" ? resolved.target.extension?.ref : undefined).toBe("ghcr.io/acme/ext:2");

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

// The four knobs that used to force a TEMPLATE edit even though the shape never changed — the whole point of the
// instance layer is that a behavioral variation is a delta, not a new structure version.
describe("resolveHarnessInstance — variation knobs that must not require a new template version", () => {
  const svcTemplate: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
    kind: "service",
    category: "topology",
    id: "vary",
    version: "1",
    services: [
      {
        name: "planner",
        needs: [],
        image: "ghcr.io/acme/planner:base",
        env: { LOG_LEVEL: "info", OPENAI_BASE_URL: "http://litellm:4000" },
        model: "gpt-4o",
      },
    ],
    dependencies: [],
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://o:4318" },
  });

  it("a template service's image is the slot default, so an instance pins only what it changes", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "vary", version: "1" },
      id: "vary",
      version: "v1",
      pins: {}, // nothing pinned — the template's own image stands in
    });
    const resolved = resolveHarnessInstance(svcTemplate, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services[0]?.image).toBe("ghcr.io/acme/planner:base");
  });

  it("a pin still wins over the template's default image", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "vary", version: "1" },
      id: "vary",
      version: "pr-9",
      pins: { planner: "ghcr.io/acme/planner:pr-9" },
    });
    const resolved = resolveHarnessInstance(svcTemplate, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services[0]?.image).toBe("ghcr.io/acme/planner:pr-9");
  });

  it("overrides.services[].model rebinds the agent-server model without touching the shape", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "vary", version: "1" },
      id: "vary-opus",
      version: "v1",
      overrides: { services: { planner: { model: "claude-opus-4-8" } } },
    });
    const resolved = resolveHarnessInstance(svcTemplate, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services[0]?.model).toBe("claude-opus-4-8");
  });

  it("overrides.services[].unsetEnv drops a template env default (which a merge-only overlay cannot express)", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "vary", version: "1" },
      id: "vary-direct",
      version: "v1",
      overrides: { services: { planner: { unsetEnv: ["OPENAI_BASE_URL"] } } },
    });
    const resolved = resolveHarnessInstance(svcTemplate, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services[0]?.env).toEqual({ LOG_LEVEL: "info" });
  });

  it("unsetEnv naming a key the template never set is a no-op, not an error", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "vary", version: "1" },
      id: "vary",
      version: "v1",
      overrides: { services: { planner: { unsetEnv: ["NOT_THERE"] } } },
    });
    const resolved = resolveHarnessInstance(svcTemplate, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services[0]?.env).toEqual({ LOG_LEVEL: "info", OPENAI_BASE_URL: "http://litellm:4000" });
  });

  it("a command instance can ask for a bigger box (overrides.resources) and drop a template env key", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "command",
      category: "cli-agent",
      id: "aider",
      version: "1",
      command: "aider --message {{task}} .",
      env: { AIDER_YES: "1", OPENAI_BASE_URL: "http://litellm:4000" },
      resources: { cpu: 1000, memoryMb: 2048 },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "aider", version: "1" },
      id: "aider-heavy",
      version: "v1",
      overrides: { resources: { cpu: 4000, memoryMb: 8192 }, unsetEnv: ["OPENAI_BASE_URL"] },
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "command") throw new Error("expected command");
    expect(resolved.resources).toEqual({ cpu: 4000, memoryMb: 8192 });
    expect(resolved.env).toEqual({ AIDER_YES: "1" });
  });

  it("a command instance without a resources override keeps the template's request", () => {
    const tpl: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
      kind: "command",
      category: "cli-agent",
      id: "aider",
      version: "1",
      command: "aider .",
      resources: { cpu: 1000, memoryMb: 2048 },
    });
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "aider", version: "1" },
      id: "aider",
      version: "v1",
    });
    const resolved = resolveHarnessInstance(tpl, instance);
    if (resolved.kind !== "command") throw new Error("expected command");
    expect(resolved.resources).toEqual({ cpu: 1000, memoryMb: 2048 });
  });

  it("a host-exec template service still refuses an image (nothing would run it)", () => {
    const res = HarnessTemplateSpecSchema.safeParse({
      kind: "service",
      category: "topology",
      id: "bad",
      version: "1",
      services: [{ name: "win-ui", image: "reg/oops:1", exec: { kind: "host", command: ["x.exe"] } }],
      dependencies: [],
      frontDoor: { service: "win-ui", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    expect(res.success).toBe(false);
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

// pinSources — store provenance annotation for pins filled from environment capabilities. The pin VALUE stays the
// verbatim ref (no-rewrite invariant); resolve must ignore the annotation entirely. environment-image-store.md.
describe("HarnessInstanceSpec.pinSources (store provenance annotation)", () => {
  it("round-trips through the schema and is ignored by resolve — the pinned image is byte-identical", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "pr-1",
      pins: { planner: "ghcr.io/acme/officeqa-env@sha256:ab", browser: "b:1", action: "a:1" },
      pinSources: { planner: { source: "acme", id: "officeqa-env", version: "1.0.0" } },
    });
    expect(instance.pinSources?.planner?.id).toBe("officeqa-env");
    const resolved = resolveHarnessInstance(buTemplate, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.find((s) => s.name === "planner")?.image).toBe("ghcr.io/acme/officeqa-env@sha256:ab");
    expect("pinSources" in resolved).toBe(false);
  });

  it("rejects a malformed pin source (unknown key)", () => {
    expect(
      HarnessInstanceSpecSchema.safeParse({
        template: { id: "bu", version: "1" },
        id: "bu",
        version: "pr-1",
        pinSources: { planner: { source: "acme", id: "e", version: "1", image: "x" } },
      }).success,
    ).toBe(false);
  });
});

describe("resolveHarnessInstance — host-exec services (no container, no image pin)", () => {
  const winTemplate: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
    kind: "service",
    category: "topology",
    id: "native-win",
    version: "1",
    services: [
      { name: "agent", needs: [] },
      {
        name: "win-ui",
        needs: [],
        requires: { os: "windows" },
        exec: { kind: "host", command: ["C:/drivers/ui-driver.exe", "--serve"] },
      },
    ],
    dependencies: [],
    frontDoor: { service: "agent", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://o:4318" },
  });

  it("a host-exec service needs no pin — it resolves imageless with its exec carried through", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "native-win", version: "1" },
      id: "native-win",
      version: "1.0.0",
      pins: { agent: "reg/agent:1" }, // only the containerized service is pinned
    });
    const resolved = resolveHarnessInstance(winTemplate, instance);
    if (resolved.kind !== "service") throw new Error("expected service");
    const win = resolved.services.find((s) => s.name === "win-ui");
    expect(win?.image).toBeUndefined();
    expect(win?.exec).toEqual({ kind: "host", command: ["C:/drivers/ui-driver.exe", "--serve"] });
  });

  it("pinning an image onto a host-exec slot is a BadRequest (nothing would run it)", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "native-win", version: "1" },
      id: "native-win",
      version: "1.0.0",
      pins: { agent: "reg/agent:1", "win-ui": "reg/oops:1" },
    });
    expect(() => resolveHarnessInstance(winTemplate, instance)).toThrow(BadRequestError);
  });

  it("a host-exec template service without exec.command is rejected at the schema boundary", () => {
    const res = HarnessTemplateSpecSchema.safeParse({
      kind: "service",
      category: "topology",
      id: "bad",
      version: "1",
      services: [{ name: "win-ui", exec: { kind: "host" } }],
      dependencies: [],
      frontDoor: { service: "win-ui", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    });
    expect(res.success).toBe(false);
  });
});

// ── THE CONVERSATION CONTRACT REACHES A REGISTERED COMMAND HARNESS (docs/command-harness.md) ─────────
//
// Registration is template-only, so a contract the TEMPLATE cannot hold is one no registered command harness
// could declare: the `conversational` marker would be reachable only by hand-built specs nobody registers.
// RED before the fix: the template schema had no `conversation`, and the resolve dropped it.
describe("command template → resolved spec carries the conversation contract", () => {
  const template = {
    kind: "command" as const,
    category: "cli-agent",
    id: "codex-t",
    version: "1.0.0",
    image: "node:22",
    command: "codex exec {{conversation}} --json {{task}}",
    conversation: { resume: "resume {{resume}}", token: { pattern: "thread_id\\W+([0-9a-f-]{36})" } },
  };
  it("a registered template's contract lands on the resolved spec, so the adapter is conversational", () => {
    const parsed = HarnessTemplateSpecSchema.parse(template);
    const resolved = resolveHarnessInstance(parsed, {
      template: { id: "codex-t", version: "1.0.0" },
      id: "codex",
      version: "1.0.0",
      pins: { image: "reg/codex@sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    });
    expect(resolved.kind).toBe("command");
    if (resolved.kind === "command") expect(resolved.conversation).toEqual(template.conversation);
  });
  it("refuses a template that declares the contract with no {{conversation}} slot — checked where it enters", () => {
    expect(HarnessTemplateSpecSchema.safeParse({ ...template, command: "codex exec --json {{task}}" }).success).toBe(
      false,
    );
  });
});

// ── WHO CHANGES THIS SLOT (docs/architecture/evolution-routing-spec.md §1) ──────────────────────────
//
// The driver used to ask the member which coding agent maintains a slot's repository. The slot's `source` says.
describe("resolveDelegate — the slot's maintainer is a lookup, and every miss is named", () => {
  const service = (name: string, source?: Record<string, unknown>) => ({
    name,
    slot: name,
    port: 8080,
    needs: [],
    perRun: [],
    replicas: 1,
    ...(source !== undefined ? { source } : {}),
  });
  const topology = (services: unknown[]) =>
    HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "shop",
      version: "1",
      services,
      dependencies: [],
      frontDoor: { service: "web", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://otel:4318" },
    });

  it("answers the profile a slot's source names, with its pinned version when one is declared", () => {
    const tpl = topology([
      service("web", {
        git: "https://github.com/acme/web.git",
        repo: "acme/web",
        maintainer: { profile: "codex-web" },
      }),
      service("api", {
        git: "https://github.com/acme/api.git",
        repo: "acme/api",
        maintainer: { profile: "claude-api", version: "2.0.0" },
      }),
    ]);
    expect(resolveDelegate(tpl, "web")).toEqual({ kind: "profile", slot: "web", profile: "codex-web" });
    expect(resolveDelegate(tpl, "api")).toEqual({
      kind: "profile",
      slot: "api",
      profile: "claude-api",
      version: "2.0.0",
    });
  });

  it("an unnamed slot resolves when exactly one slot carries code, and is ambiguous when several do", () => {
    const one = topology([
      service("web", { git: "https://github.com/acme/web.git", maintainer: { profile: "codex-web" } }),
      service("db"),
    ]);
    expect(resolveDelegate(one)).toEqual({ kind: "profile", slot: "web", profile: "codex-web" });
    const two = topology([
      service("web", { git: "https://github.com/acme/web.git", maintainer: { profile: "codex-web" } }),
      service("api", { git: "https://github.com/acme/api.git", maintainer: { profile: "claude-api" } }),
    ]);
    expect(resolveDelegate(two)).toEqual({ kind: "ambiguous", slots: ["web", "api"] });
  });

  it("a slot with code and no maintainer is `unmapped` — the brief says to declare one, not to ask a member", () => {
    const tpl = topology([service("web", { git: "https://github.com/acme/web.git" })]);
    expect(resolveDelegate(tpl, "web")).toEqual({ kind: "unmapped", slot: "web" });
    expect(resolveDelegate(tpl)).toEqual({ kind: "unmapped", slot: "web" });
  });

  it("a slot the template does not have is named back with the slots it does", () => {
    const tpl = topology([service("web", { git: "https://github.com/acme/web.git" }), service("db")]);
    expect(resolveDelegate(tpl, "worker")).toEqual({ kind: "no_such_slot", slot: "worker", slots: ["web", "db"] });
  });

  it("a command template has one slot, `image`, and its source's maintainer answers for it", () => {
    const tpl = HarnessTemplateSpecSchema.parse({
      kind: "command",
      category: "cli-agent",
      id: "codex",
      version: "1.0.0",
      image: "node:22",
      command: "codex exec {{task}}",
      source: { git: "https://github.com/acme/codex-scaffold.git", maintainer: { profile: "codex" } },
    });
    expect(resolveDelegate(tpl)).toEqual({ kind: "profile", slot: "image", profile: "codex" });
    const bare = HarnessTemplateSpecSchema.parse({
      kind: "command",
      category: "cli-agent",
      id: "aider",
      version: "1.0.0",
      image: "python:3.12",
      command: "aider {{task}}",
    });
    // No source at all: nothing carries code, so there is nothing to map — ambiguous over an empty set, not a
    // profile invented from thin air.
    expect(resolveDelegate(bare)).toEqual({ kind: "ambiguous", slots: [] });
  });
});

// ── SEEDS RIDE THE VERSION (docs/architecture/harness-identity-and-seeds-spec.md §2) ──────────────────
describe("resolveHarnessInstance — the instance's seeds land on the resolved spec, so they are inside its digest", () => {
  const seeds = {
    skills: [{ id: "triage", version: "1.2.0", digest: "sha256:aaaa" }],
    knowledge: [{ id: "k1", digest: "sha256:bbbb" }],
  };
  it("carries seeds onto a command, a service and a process resolution alike", () => {
    const command = HarnessTemplateSpecSchema.parse({
      kind: "command",
      category: "cli-agent",
      id: "codex",
      version: "1.0.0",
      image: "node:22",
      command: "codex exec {{task}}",
    });
    const resolved = resolveHarnessInstance(command, {
      template: { id: "codex", version: "1.0.0" },
      id: "codex",
      version: "1.0.0",
      pins: {},
      seeds,
    });
    expect(resolved.seeds).toEqual(seeds);
    const process = HarnessTemplateSpecSchema.parse({
      kind: "process",
      category: "builtin",
      id: "claude-code",
      version: "1",
    });
    expect(
      resolveHarnessInstance(process, {
        template: { id: "claude-code", version: "1" },
        id: "claude-code",
        version: "1.0.0",
        pins: {},
        seeds,
      }).seeds,
    ).toEqual(seeds);
  });
  it("an instance without seeds resolves to a spec without them — never an empty declaration", () => {
    const command = HarnessTemplateSpecSchema.parse({
      kind: "command",
      category: "cli-agent",
      id: "codex",
      version: "1.0.0",
      image: "node:22",
      command: "codex exec {{task}}",
    });
    expect(
      resolveHarnessInstance(command, {
        template: { id: "codex", version: "1.0.0" },
        id: "codex",
        version: "1.0.0",
        pins: {},
      }).seeds,
    ).toBeUndefined();
  });
});

// ── THE CASE REACHES THE COMMAND THROUGH AN ALLOWLIST (docs/architecture/harness-definability-spec.md §4) ──
describe("{{case.*}} tokens — refused at the template door unless allowlisted; a process harness declares its box", () => {
  const command = (cmd: string) => ({
    kind: "command",
    category: "cli-agent",
    id: "agent",
    version: "1.0.0",
    image: "node:22",
    command: cmd,
  });
  it("accepts the allowlisted case fields and refuses any other, naming the list", () => {
    expect(
      HarnessTemplateSpecSchema.safeParse(
        command("agent --repo {{case.env.repo.url}}@{{case.env.repo.ref}} --case {{case.id}} {{task}}"),
      ).success,
    ).toBe(true);
    const refused = HarnessTemplateSpecSchema.safeParse(command("agent --tests {{case.tests}} {{task}}"));
    expect(refused.success).toBe(false);
    if (!refused.success)
      expect(refused.error.issues.map((i) => i.message).join("\n")).toMatch(
        /unknown case token\(s\) \{\{case\.tests\}\}/,
      );
    expect(caseTokenDefects("x {{case.env.kind}} {{ case.id }}")).toEqual([]);
    expect(caseTokenDefects("x {{case.env}}")).toHaveLength(1);
  });
  it("a process template's resources ride the resolved spec, and every lane reads them through one predicate", () => {
    const tpl = HarnessTemplateSpecSchema.parse({
      kind: "process",
      category: "builtin",
      id: "claude-code",
      version: "1",
      resources: { cpu: 2000, memoryMb: 4096 },
    });
    const resolved = resolveHarnessInstance(tpl, {
      template: { id: "claude-code", version: "1" },
      id: "claude-code",
      version: "1.0.0",
      pins: {},
    });
    expect(resolved.kind === "process" ? resolved.resources : undefined).toEqual({ cpu: 2000, memoryMb: 4096 });
    expect(harnessResourcesOf(resolved)).toEqual({ cpu: 2000, memoryMb: 4096 });
    expect(harnessResourcesOf(undefined)).toBeUndefined();
    const svc = HarnessTemplateSpecSchema.parse({
      kind: "service",
      category: "topology",
      id: "shop",
      version: "1",
      services: [
        {
          name: "web",
          slot: "web",
          port: 8080,
          needs: [],
          perRun: [],
          replicas: 1,
          resources: { cpu: 500, memoryMb: 512 },
        },
      ],
      dependencies: [],
      frontDoor: { service: "web", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://otel:4318" },
    });
    expect(
      harnessResourcesOf(
        resolveHarnessInstance(svc, {
          template: { id: "shop", version: "1" },
          id: "shop",
          version: "1.0.0",
          pins: { web: "img" },
        }),
      ),
    ).toBeUndefined();
  });
});

// ── A TARGET IS NOT ALWAYS A BROWSER (docs/architecture/harness-definability-spec.md §1) ──────────────
describe("targets — browser | api | os, each obtainable or refused where it enters", () => {
  const topology = (target: unknown) => ({
    kind: "service",
    category: "topology",
    id: "shop",
    version: "1",
    services: [{ name: "web", slot: "web", port: 8080, needs: [], perRun: [], replicas: 1 }],
    dependencies: [],
    frontDoor: { service: "web", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://otel:4318" },
    target,
  });
  const command = (target: unknown) => ({
    kind: "command",
    category: "cli-agent",
    id: "client",
    version: "1.0.0",
    image: "node:22",
    command: "client --base {{target.baseUrl}} {{task}}",
    target,
  });
  it("a browser target is unchanged; an api target names a baseUrl or a session API; an os target needs a session API", () => {
    expect(HarnessTemplateSpecSchema.safeParse(topology({ kind: "browser", engine: "chromium" })).success).toBe(true);
    expect(
      HarnessTemplateSpecSchema.safeParse(topology({ kind: "api", baseUrl: "https://shop.internal" })).success,
    ).toBe(true);
    expect(
      HarnessTemplateSpecSchema.safeParse(
        topology({
          kind: "api",
          acquire: { mode: "service", service: "web", open: "POST /sessions", coordinates: { target_base_url: "url" } },
        }),
      ).success,
    ).toBe(true);
    expect(targetDefects({ kind: "api", observe: ["request", "response"] }, "service")).toHaveLength(1);
    expect(targetDefects({ kind: "os", os: "linux", observe: ["screenshot", "window"] }, "service")).toHaveLength(1);
    expect(
      targetDefects(
        {
          kind: "os",
          os: "linux",
          observe: ["screenshot", "window"],
          acquire: { mode: "service", service: "desk", open: "POST /sessions", coordinates: {} },
        },
        "service",
      ),
    ).toEqual([]);
  });
  it("a command harness's target is a static api and is carried onto the resolved spec; a browser or an acquired target is refused", () => {
    const parsed = HarnessTemplateSpecSchema.parse(command({ kind: "api", baseUrl: "https://shop.internal" }));
    const resolved = resolveHarnessInstance(parsed, {
      template: { id: "client", version: "1.0.0" },
      id: "client",
      version: "1.0.0",
      pins: {},
    });
    expect(resolved.kind === "command" ? resolved.target : undefined).toMatchObject({
      kind: "api",
      baseUrl: "https://shop.internal",
    });
    expect(HarnessTemplateSpecSchema.safeParse(command({ kind: "browser", engine: "chromium" })).success).toBe(false);
    expect(
      HarnessTemplateSpecSchema.safeParse(
        command({ kind: "api", acquire: { mode: "service", service: "web", open: "POST /s", coordinates: {} } }),
      ).success,
    ).toBe(false);
    // …and the extension override still only means something on a browser target.
    const apiTopology = HarnessTemplateSpecSchema.parse(topology({ kind: "api", baseUrl: "https://shop.internal" }));
    expect(() =>
      resolveHarnessInstance(apiTopology, {
        template: { id: "shop", version: "1" },
        id: "shop",
        version: "1.0.0",
        pins: { web: "img" },
        overrides: { target: { extension: { ref: "ghcr.io/acme/ext:2" } } },
      }),
    ).toThrow(/not a browser/);
  });
});
