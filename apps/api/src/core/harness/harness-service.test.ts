import { deleteHarnessVersion, harnessVisibleTo } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import {
  ConflictError,
  ForbiddenError,
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
  NotFoundError,
} from "@everdict/contracts";
import { InMemoryHarnessInstanceRegistry, InMemoryHarnessTemplateRegistry } from "@everdict/registry";
import { beforeEach, describe, expect, it } from "vitest";

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

// Regression: a private (user-secret) harness must be visible to the creator of the LATEST version — the version
// that decides privacy — even when the id's FIRST version was registered without a creator stamp (the old MCP
// register path) or by someone else. The old check keyed off the id-level (earliest-version) creator, which hid
// the harness from everyone, including its actual owner.
describe("harnessVisibleTo (private = latest-version owner)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;

  const PRIVATE_TEMPLATE: HarnessTemplateSpec = {
    kind: "command",
    category: "browser-agent",
    id: "h",
    version: "2",
    command: "run {{task}}",
    setup: [],
    params: {},
    env: { API_KEY: { secretRef: "API_KEY", scope: "user" } },
    trace: { kind: "none" },
  };

  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", TEMPLATE);
    await templates.register("acme", PRIVATE_TEMPLATE);
    // First version: no creator stamp (old MCP path). Latest version: alice's, referencing her personal secret.
    await instances.register("acme", instance("0.5.0"));
    await instances.register(
      "acme",
      { template: { id: "h", version: "2" }, id: "h", version: "1.0.0", pins: {} },
      "alice",
    );
  });

  it("the creator of the latest (privacy-deciding) version sees the harness", async () => {
    expect(await harnessVisibleTo(instances, p({ subject: "alice" }), "h")).toBe(true);
  });

  it("another member does not see it", async () => {
    expect(await harnessVisibleTo(instances, p({ subject: "bob" }), "h")).toBe(false);
  });

  it("the list entry carries latestCreatedBy so list filters agree with detail visibility", async () => {
    const entry = (await instances.list("acme")).find((e) => e.id === "h");
    expect(entry?.private).toBe(true);
    expect(entry?.latestCreatedBy).toBe("alice");
    expect(entry?.createdBy).toBeUndefined(); // earliest version had no stamp — the old filter key
  });
});
