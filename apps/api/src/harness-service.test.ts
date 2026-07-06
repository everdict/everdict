import type { Principal } from "@assay/auth";
import {
  ConflictError,
  ForbiddenError,
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
  NotFoundError,
} from "@assay/core";
import { InMemoryHarnessInstanceRegistry, InMemoryHarnessTemplateRegistry } from "@assay/registry";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteHarnessVersion } from "./harness-service.js";

const TEMPLATE: HarnessTemplateSpec = {
  kind: "command",
  category: "cli-agent",
  id: "h",
  version: "1",
  command: "echo hi",
  setup: [],
  params: {},
  env: {},
  trace: { kind: "none" },
};

const instance = (version: string): HarnessInstanceSpec => ({
  template: { id: "h", version: "1" },
  id: "h",
  version,
  pins: {},
});

const p = (over: Partial<Principal>): Principal => ({
  subject: "alice",
  workspace: "acme",
  roles: ["member"],
  via: "oidc",
  ...over,
});

describe("deleteHarnessVersion (생성자-또는-admin, tombstone)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;

  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", TEMPLATE);
    await instances.register("acme", instance("1.0.0"), "alice");
    await instances.register("acme", instance("2.0.0"), "alice");
  });

  it("버전 생성자 본인(member)은 삭제할 수 있다 — read 에서 사라지고 이력 데이터는 tombstone", async () => {
    const res = await deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0");
    expect(res).toEqual({ workspace: "acme", id: "h", version: "2.0.0", deleted: true });
    expect(await instances.versions("acme", "h")).toEqual(["1.0.0"]); // 삭제 버전 제외
    await expect(instances.get("acme", "h", "2.0.0")).rejects.toBeInstanceOf(NotFoundError);
    expect((await instances.list("acme")).find((e) => e.id === "h")?.versions).toEqual(["1.0.0"]);
  });

  it("워크스페이스 admin 은 남의 버전도 삭제할 수 있다", async () => {
    await deleteHarnessVersion(instances, p({ subject: "boss", roles: ["admin"] }), "h", "1.0.0");
    expect(await instances.versions("acme", "h")).toEqual(["2.0.0"]);
  });

  it("생성자 아닌 member 는 403", async () => {
    await expect(deleteHarnessVersion(instances, p({ subject: "bob" }), "h", "1.0.0")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("없는/이미 삭제된/타 워크스페이스 버전은 404", async () => {
    await expect(deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "9.9.9")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0");
    await expect(deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      deleteHarnessVersion(instances, p({ subject: "alice", workspace: "beta" }), "h", "1.0.0"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("동일 내용 재등록은 부활(revive), 다른 내용은 여전히 Conflict(버전 불변)", async () => {
    await deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0");
    await instances.register("acme", instance("2.0.0"), "alice"); // 동일 내용 → 부활
    expect(await instances.versions("acme", "h")).toEqual(["1.0.0", "2.0.0"]);
    await deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0");
    await expect(
      instances.register("acme", { ...instance("2.0.0"), pins: { model: "x" } }, "alice"),
    ).rejects.toBeInstanceOf(ConflictError); // 삭제됐어도 내용 불변은 유지
  });
});
