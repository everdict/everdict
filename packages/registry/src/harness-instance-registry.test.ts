import { BadRequestError, ConflictError, type HarnessTemplateSpec, NotFoundError } from "@assay/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryHarnessInstanceRegistry } from "./harness-instance-registry.js";
import { InMemoryHarnessTemplateRegistry } from "./harness-template-registry.js";
import { SHARED_TENANT } from "./registry.js";

const buTemplate: HarnessTemplateSpec = {
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

const instance = (version: string, pins: Record<string, string>) => ({
  template: { id: "bu", version: "1" },
  id: "bu",
  version,
  pins,
});

describe("HarnessInstanceRegistry", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;
  beforeEach(() => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
  });

  it("템플릿 + 인스턴스 등록 후 get() 이 resolved HarnessSpec 을 돌려준다", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }));
    const resolved = await instances.get("acme", "bu", "pr-1");
    expect(resolved.kind).toBe("service");
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.map((s) => s.image)).toEqual(["p:1", "b:1"]);
    expect(resolved.version).toBe("pr-1");
  });

  it("템플릿 없이 인스턴스 등록 → NotFoundError", async () => {
    await expect(instances.register("acme", instance("x", { planner: "p", browser: "b" }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("슬롯 pin 누락 인스턴스 등록 → BadRequestError (등록 거부)", async () => {
    await templates.register("acme", buTemplate);
    await expect(instances.register("acme", instance("x", { planner: "p" }))).rejects.toBeInstanceOf(BadRequestError);
    expect(await instances.has("acme", "bu", "x")).toBe(false); // 거부되어 저장 안 됨
  });

  it("같은 버전 다른 pins 재등록 → ConflictError (버전 불변)", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }));
    await expect(
      instances.register("acme", instance("pr-1", { planner: "p:2", browser: "b:1" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("_shared 템플릿 + 테넌트 인스턴스 → 폴백 resolve", async () => {
    await templates.register(SHARED_TENANT, buTemplate); // first-party 템플릿
    await instances.register("acme", instance("pr-9", { planner: "p:9", browser: "b:9" }));
    const resolved = await instances.get("acme", "bu", "latest");
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.map((s) => s.image)).toEqual(["p:9", "b:9"]);
  });

  it("list 가 같은 템플릿 id 아래 인스턴스 버전들을 묶고 목록 메타(category/kind/subtitle/versionCount)를 얹는다", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }));
    await instances.register("acme", instance("pr-2", { planner: "p:2", browser: "b:2" }));
    const list = await instances.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "bu",
      owner: "acme",
      versions: ["pr-1", "pr-2"],
      latestVersion: "pr-2",
      versionCount: 2,
      category: "topology", // 템플릿 대분류
      kind: "service", // resolved
      subtitle: "2개 서비스",
    });
  });

  it("register 의 createdBy(subject)가 목록 메타(최초 등록 버전)로 노출된다", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }), "user-carol");
    await instances.register("acme", instance("pr-2", { planner: "p:2", browser: "b:2" }), "user-dave");
    const list = await instances.list("acme");
    expect(list[0]?.createdBy).toBe("user-carol"); // 최초 등록 버전의 subject
  });
});

describe("버전 태그 — 스펙 밖 가변 레지스트리 메타(자유 라벨, 버전 분간용)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;
  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("1.0.0", { planner: "p:1", browser: "b:1" }));
    await instances.register("acme", instance("1.1.0", { planner: "p:2", browser: "b:2" }));
  });

  it("setVersionTags 가 붙인 태그를 versionTags/list.versionTags 로 노출한다(전체 교체; 빈 배열 = 제거)", async () => {
    await instances.setVersionTags("acme", "bu", "1.0.0", ["baseline"]);
    expect(await instances.versionTags("acme", "bu")).toEqual({ "1.0.0": ["baseline"] });
    expect((await instances.list("acme"))[0]?.versionTags).toEqual({ "1.0.0": ["baseline"] });
    await instances.setVersionTags("acme", "bu", "1.0.0", []);
    expect(await instances.versionTags("acme", "bu")).toEqual({});
    expect((await instances.list("acme"))[0]?.versionTags).toBeUndefined();
  });

  it("태그는 버전 불변성과 무관 — 태그 후에도 같은 pins 재등록은 멱등(Conflict 아님)", async () => {
    await instances.setVersionTags("acme", "bu", "1.0.0", ["baseline"]);
    await instances.register("acme", instance("1.0.0", { planner: "p:1", browser: "b:1" }));
    expect(await instances.versionTags("acme", "bu")).toEqual({ "1.0.0": ["baseline"] });
  });

  it("없는·삭제된 버전은 NotFound; 삭제된 버전은 versionTags read 에서도 빠진다", async () => {
    await expect(instances.setVersionTags("acme", "bu", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
    await instances.setVersionTags("acme", "bu", "1.0.0", ["baseline"]);
    await instances.softDelete("acme", "bu", "1.0.0");
    expect(await instances.versionTags("acme", "bu")).toEqual({});
    await expect(instances.setVersionTags("acme", "bu", "1.0.0", ["y"])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("resolveWithPins — 제출 시점 임시 핀(레지스트리 무변경)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;
  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("v1", { planner: "p:1", browser: "b:1" }));
  });

  it("인스턴스 pins 위에 임시 핀을 병합해 resolve 하고, 저장된 버전/핀은 그대로다", async () => {
    const resolved = await instances.resolveWithPins("acme", "bu", "v1", { planner: "p:pr-7" });
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.map((s) => s.image)).toEqual(["p:pr-7", "b:1"]); // planner 만 스왑
    expect(await instances.versions("acme", "bu")).toEqual(["v1"]); // 새 버전 없음(레지스트리 무변경)
    const stored = await instances.get("acme", "bu", "v1");
    if (stored.kind !== "service") throw new Error("expected service");
    expect(stored.services.map((s) => s.image)).toEqual(["p:1", "b:1"]); // 저장본 원본 그대로
  });

  it("알 수 없는 슬롯 핀 → BadRequestError (오타를 조용히 무시하면 PR 이미지가 안 갈린 채 통과한다)", async () => {
    await expect(instances.resolveWithPins("acme", "bu", "v1", { nope: "x" })).rejects.toBeInstanceOf(BadRequestError);
  });
});
