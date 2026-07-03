import { BadRequestError, type HarnessTemplateSpec } from "@assay/core";
import { InMemoryHarnessInstanceRegistry, InMemoryHarnessTemplateRegistry } from "@assay/registry";
import { beforeEach, describe, expect, it } from "vitest";
import { repinHarnessImages } from "./harness-pin-service.js";

const template: HarnessTemplateSpec = {
  kind: "service",
  category: "topology",
  id: "bu",
  version: "1",
  services: [
    { name: "planner", needs: [], perRun: [], replicas: 1, env: {} },
    { name: "browser", needs: [], perRun: [], replicas: 1, env: {} },
  ],
  dependencies: [],
  frontDoor: { service: "planner", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
};

const digest = (name: string, fill: string) => `ghcr.io/acme/${name}@sha256:${fill.repeat(64)}`;

describe("repinHarnessImages — durable 재핀(headless re-pin)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;
  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", template);
  });

  const seed = (version: string) =>
    instances.register("acme", {
      template: { id: "bu", version: "1" },
      id: "bu",
      version,
      pins: { planner: digest("planner", "a"), browser: digest("browser", "b") },
    });

  it("tag 핀은 기본 거부(digest 강제) — allowTags:true 로만 허용", async () => {
    await seed("1.0.0");
    await expect(
      repinHarnessImages(instances, "acme", "ci", "bu", { pins: { planner: "p:dev" }, allowTags: false }),
    ).rejects.toBeInstanceOf(BadRequestError);
    const ok = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: "p:dev" },
      allowTags: true,
    });
    expect(ok.unchanged).toBe(false);
  });

  it("semver 기준 버전은 patch bump 로 새 버전을 등록하고 기준 pins 위에 병합한다", async () => {
    await seed("1.0.0");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "c") },
      allowTags: false,
    });
    expect(result).toMatchObject({ id: "bu", version: "1.0.1", base: "1.0.0", unchanged: false });
    expect(result.pins).toEqual({ planner: digest("planner", "c"), browser: digest("browser", "b") }); // browser 유지
    const resolved = await instances.get("acme", "bu", "1.0.1");
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.find((s) => s.name === "planner")?.image).toBe(digest("planner", "c"));
  });

  it("동일 핀 재요청은 unchanged(멱등) — 새 버전을 만들지 않는다", async () => {
    await seed("1.0.0");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "a") }, // 기준과 동일
      allowTags: false,
    });
    expect(result).toMatchObject({ version: "1.0.0", unchanged: true });
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0"]);
  });

  it("비-semver 기준 버전은 -r<n> 접미사로 bump 한다", async () => {
    await seed("pr-1");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "d") },
      allowTags: false,
    });
    expect(result.version).toBe("pr-1-r2");
  });

  it("명시 version(dev-<sha>)이 자동 bump 보다 우선한다", async () => {
    await seed("1.0.0");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "e") },
      version: "dev-abc1234",
      allowTags: false,
    });
    expect(result.version).toBe("dev-abc1234");
    expect(await instances.has("acme", "bu", "dev-abc1234")).toBe(true);
  });

  it("모노레포: 여러 슬롯을 한 호출에 → 정확히 새 버전 하나", async () => {
    await seed("1.0.0");
    await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "f"), browser: digest("browser", "0") },
      allowTags: false,
    });
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0", "1.0.1"]);
  });

  it("알 수 없는 슬롯 → BadRequest, 아무것도 등록되지 않는다", async () => {
    await seed("1.0.0");
    await expect(
      repinHarnessImages(instances, "acme", "ci", "bu", {
        pins: { nope: digest("nope", "1") },
        allowTags: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0"]); // 등록 없음
  });
});
