import type { Principal } from "@everdict/auth";
import {
  ConflictError,
  ForbiddenError,
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
  NotFoundError,
} from "@everdict/core";
import { InMemoryHarnessInstanceRegistry, InMemoryHarnessTemplateRegistry } from "@everdict/registry";
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

describe("deleteHarnessVersion (creator-or-admin, tombstone)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;

  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", TEMPLATE);
    await instances.register("acme", instance("1.0.0"), "alice");
    await instances.register("acme", instance("2.0.0"), "alice");
  });

  it("the version's creator (member) can delete it — disappears from reads while the historical data is a tombstone", async () => {
    const res = await deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0");
    expect(res).toEqual({ workspace: "acme", id: "h", version: "2.0.0", deleted: true });
    expect(await instances.versions("acme", "h")).toEqual(["1.0.0"]); // the deleted version is excluded
    await expect(instances.get("acme", "h", "2.0.0")).rejects.toBeInstanceOf(NotFoundError);
    expect((await instances.list("acme")).find((e) => e.id === "h")?.versions).toEqual(["1.0.0"]);
  });

  it("a workspace admin can delete others' versions too", async () => {
    await deleteHarnessVersion(instances, p({ subject: "boss", roles: ["admin"] }), "h", "1.0.0");
    expect(await instances.versions("acme", "h")).toEqual(["2.0.0"]);
  });

  it("a member who isn't the creator → 403", async () => {
    await expect(deleteHarnessVersion(instances, p({ subject: "bob" }), "h", "1.0.0")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("missing / already-deleted / other-workspace version → 404", async () => {
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

  it("re-registering the same content revives it, different content is still Conflict (version immutable)", async () => {
    await deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0");
    await instances.register("acme", instance("2.0.0"), "alice"); // same content → revive
    expect(await instances.versions("acme", "h")).toEqual(["1.0.0", "2.0.0"]);
    await deleteHarnessVersion(instances, p({ subject: "alice" }), "h", "2.0.0");
    await expect(
      instances.register("acme", { ...instance("2.0.0"), pins: { model: "x" } }, "alice"),
    ).rejects.toBeInstanceOf(ConflictError); // even when deleted, content immutability holds
  });
});
