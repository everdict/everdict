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
    { name: "planner", needs: [], perRun: [], replicas: 1 },
    { name: "browser", needs: [], perRun: [], replicas: 1 },
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

  it("list 가 같은 템플릿 id 아래 인스턴스 버전들을 묶는다", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }));
    await instances.register("acme", instance("pr-2", { planner: "p:2", browser: "b:2" }));
    const list = await instances.list("acme");
    expect(list).toEqual([{ id: "bu", owner: "acme", versions: ["pr-1", "pr-2"] }]);
  });
});
