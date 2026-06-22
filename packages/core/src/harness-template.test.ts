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
