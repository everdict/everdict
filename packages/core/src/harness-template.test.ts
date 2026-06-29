import { describe, expect, it } from "vitest";
import { BadRequestError } from "./errors.js";
import {
  HarnessInstanceSpecSchema,
  type HarnessTemplateSpec,
  HarnessTemplateSpecSchema,
  resolveHarnessInstance,
} from "./harness-template.js";

// service 템플릿(대분류): 서비스 구조만, 이미지 없음(slot).
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
  it("템플릿 구조 + 인스턴스 pins → resolved ServiceHarnessSpec (슬롯이 이미지로 치환)", () => {
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
      ["action-stream", "reg/action:abc"], // slot 'action' 으로 핀됨
    ]);
    expect(resolved.dependencies).toHaveLength(1);
    expect(resolved.frontDoor.service).toBe("planner");
  });

  it("서비스 env 가 resolved spec 까지 보존된다(default {} 로 덮어쓰지 않음)", () => {
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

  it("서비스 volumes/readiness 가 resolved spec 까지 보존된다(런타임이 해석할 수 있도록)", () => {
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

  it("external(BYO) dependency + service 가 resolved spec 까지 보존된다", () => {
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

  it("overrides.services[].env 가 템플릿 env 위에 병합된다(인스턴스 변주 — 같은 이미지, 다른 동작)", () => {
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
    // MODEL 은 인스턴스가 덮고, LOG_LEVEL 은 템플릿 유지, TEMPERATURE 는 추가.
    expect(resolved.services[0]?.env).toEqual({ LOG_LEVEL: "info", MODEL: "claude-opus-4-8", TEMPERATURE: "0.2" });
  });

  it("overrides.frontDoor.request.bodyTemplate 가 템플릿 본문 위에 shallow-merge 된다", () => {
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

  it("overrides 대상 서비스가 템플릿에 없으면 BadRequestError", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "x",
      pins: { planner: "p", browser: "b", action: "a" },
      overrides: { services: { nope: { env: { X: "1" } } } },
    });
    expect(() => resolveHarnessInstance(buTemplate, instance)).toThrow(BadRequestError);
  });

  it("슬롯 pin 누락 → BadRequestError", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "x",
      pins: { planner: "p:1", browser: "b:1" }, // action 누락
    });
    expect(() => resolveHarnessInstance(buTemplate, instance)).toThrow(BadRequestError);
  });

  it("인스턴스의 template 참조가 템플릿과 불일치 → BadRequestError", () => {
    const instance = HarnessInstanceSpecSchema.parse({
      template: { id: "bu", version: "2" }, // 버전 불일치
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

  it("pins.image/model 이 템플릿 기본을 오버라이드", () => {
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

  it("pins 가 비면 템플릿 기본값 사용", () => {
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

  it("overrides.env/params 가 템플릿 위에 병합된다(같은 command, 다른 플래그 변주)", () => {
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
    expect(resolved.params).toEqual({ edit_format: "diff" }); // 인스턴스가 템플릿 기본을 덮음
  });
});

describe("resolveHarnessInstance — process", () => {
  it("process 템플릿 → resolved ProcessHarnessSpec(id@version)", () => {
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
