import { BadRequestError, NotFoundError } from "@assay/core";
import { InMemoryWorkspaceSettingsStore } from "@assay/db";
import { describe, expect, it } from "vitest";
import { ImageRegistryService } from "./image-registry-service.js";

function svc(secrets: Record<string, string> = {}) {
  const settings = new InMemoryWorkspaceSettingsStore();
  return { settings, service: new ImageRegistryService({ settings, secretsFor: async () => secrets }) };
}

describe("ImageRegistryService — 복수 레지스트리", () => {
  it("이름 기준 upsert 로 여러 레지스트리를 등록/갱신하고 목록으로 조회한다(imagePrefix 포함)", async () => {
    const { service } = svc();
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io", namespace: "acme" });
    await service.upsert("acme", { name: "corp", host: "registry.acme.dev:5000" });
    await service.upsert("acme", { name: "ghcr", host: "ghcr.io", namespace: "acme2" }); // 교체
    const list = await service.list("acme");
    expect(list.map((r) => r.name).sort()).toEqual(["corp", "ghcr"]);
    expect(list.find((r) => r.name === "ghcr")?.imagePrefix).toBe("ghcr.io/acme2/");
    // 분류 좌표는 전체 레지스트리.
    expect((await service.coordinates("acme")).map((c) => c.host).sort()).toEqual([
      "ghcr.io",
      "registry.acme.dev:5000",
    ]);
  });

  it("레거시 단수(imageRegistry)는 name=default 로 승계해 읽고, 첫 쓰기에서 복수 목록으로 청산한다", async () => {
    const { settings, service } = svc();
    // Given: 복수 모델 이전에 등록된 단수 설정.
    await settings.set("acme", { imageRegistry: { host: "ghcr.io", namespace: "acme", pullSecretName: "PULL" } });
    const before = await service.list("acme");
    expect(before).toHaveLength(1);
    expect(before[0]?.name).toBe("default");
    // When: 새 레지스트리 추가 — 레거시가 목록에 합류하고 단수 필드는 청산된다.
    await service.upsert("acme", { name: "corp", host: "registry.acme.dev:5000" });
    const after = await service.list("acme");
    expect(after.map((r) => r.name).sort()).toEqual(["corp", "default"]);
    expect((await settings.get("acme"))?.imageRegistry).toBeNull();
  });

  it("pullAuths 는 pull 이 구성된 레지스트리 전부를 돌려준다(시크릿 부재 항목은 조용히 제외)", async () => {
    const { service } = svc({ PULL_A: "pa" });
    await service.upsert("acme", { name: "a", host: "reg-a.io", username: "bot", pullSecretName: "PULL_A" });
    await service.upsert("acme", { name: "b", host: "reg-b.io", pullSecretName: "PULL_B" }); // 시크릿 없음 → 제외
    await service.upsert("acme", { name: "c", host: "reg-c.io" }); // pull 미구성 → 제외
    expect(await service.pullAuths("acme")).toEqual([{ host: "reg-a.io", username: "bot", password: "pa" }]);
  });

  it("pushCredentials: 복수면 이름 필수(400), 이름 불일치 404, 1개뿐이면 생략 허용", async () => {
    const { service } = svc({ PUSH: "tok" });
    await service.upsert("acme", { name: "only", host: "reg.io", pushSecretName: "PUSH" });
    // 1개뿐 — 생략 허용.
    expect((await service.pushCredentials("acme")).name).toBe("only");
    await service.upsert("acme", { name: "two", host: "reg2.io", pushSecretName: "PUSH" });
    // 복수 — 생략은 400(이름 나열), 이름 지정은 발급, 없는 이름은 404.
    await expect(service.pushCredentials("acme")).rejects.toBeInstanceOf(BadRequestError);
    expect((await service.pushCredentials("acme", "two")).host).toBe("reg2.io");
    await expect(service.pushCredentials("acme", "없음")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("remove 는 이름 지정 해제 — 나머지 레지스트리는 유지", async () => {
    const { service } = svc();
    await service.upsert("acme", { name: "a", host: "reg-a.io" });
    await service.upsert("acme", { name: "b", host: "reg-b.io" });
    await service.remove("acme", "a");
    expect((await service.list("acme")).map((r) => r.name)).toEqual(["b"]);
  });
});
