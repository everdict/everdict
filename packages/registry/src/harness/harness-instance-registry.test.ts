import { BadRequestError, ConflictError, type HarnessTemplateSpec, NotFoundError } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { SHARED_TENANT } from "../registry.js";
import { InMemoryHarnessInstanceRegistry } from "./harness-instance-registry.js";
import { InMemoryHarnessTemplateRegistry } from "./harness-template-registry.js";

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

  it("after registering template + instance, get() returns a resolved HarnessSpec", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }));
    const resolved = await instances.get("acme", "bu", "pr-1");
    expect(resolved.kind).toBe("service");
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.map((s) => s.image)).toEqual(["p:1", "b:1"]);
    expect(resolved.version).toBe("pr-1");
  });

  it("instance register without a template → NotFoundError", async () => {
    await expect(instances.register("acme", instance("x", { planner: "p", browser: "b" }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("instance register with a missing slot pin → BadRequestError (register rejected)", async () => {
    await templates.register("acme", buTemplate);
    await expect(instances.register("acme", instance("x", { planner: "p" }))).rejects.toBeInstanceOf(BadRequestError);
    expect(await instances.has("acme", "bu", "x")).toBe(false); // rejected, so not stored
  });

  it("re-registering the same version with different pins → ConflictError (version immutable)", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }));
    await expect(
      instances.register("acme", instance("pr-1", { planner: "p:2", browser: "b:1" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("_shared template + tenant instance → fallback resolve", async () => {
    await templates.register(SHARED_TENANT, buTemplate); // first-party template
    await instances.register("acme", instance("pr-9", { planner: "p:9", browser: "b:9" }));
    const resolved = await instances.get("acme", "bu", "latest");
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.map((s) => s.image)).toEqual(["p:9", "b:9"]);
  });

  it("list groups instance versions under the same template id and overlays list meta (category/kind/subtitle/versionCount)", async () => {
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
      category: "topology", // template category
      kind: "service", // resolved
      subtitle: "2 services",
    });
  });

  it("register's createdBy (subject) is exposed as list meta (first-registered version)", async () => {
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("pr-1", { planner: "p:1", browser: "b:1" }), "user-carol");
    await instances.register("acme", instance("pr-2", { planner: "p:2", browser: "b:2" }), "user-dave");
    const list = await instances.list("acme");
    expect(list[0]?.createdBy).toBe("user-carol"); // subject of the first-registered version
  });
});

describe("version tags — mutable registry meta outside the spec (free-form labels, for distinguishing versions)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;
  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("1.0.0", { planner: "p:1", browser: "b:1" }));
    await instances.register("acme", instance("1.1.0", { planner: "p:2", browser: "b:2" }));
  });

  it("tags set by setVersionTags are exposed via versionTags/list.versionTags (full replacement; empty array = remove)", async () => {
    await instances.setVersionTags("acme", "bu", "1.0.0", ["baseline"]);
    expect(await instances.versionTags("acme", "bu")).toEqual({ "1.0.0": ["baseline"] });
    expect((await instances.list("acme"))[0]?.versionTags).toEqual({ "1.0.0": ["baseline"] });
    await instances.setVersionTags("acme", "bu", "1.0.0", []);
    expect(await instances.versionTags("acme", "bu")).toEqual({});
    expect((await instances.list("acme"))[0]?.versionTags).toBeUndefined();
  });

  it("tags are independent of version immutability — after tagging, re-registering the same pins is idempotent (not Conflict)", async () => {
    await instances.setVersionTags("acme", "bu", "1.0.0", ["baseline"]);
    await instances.register("acme", instance("1.0.0", { planner: "p:1", browser: "b:1" }));
    expect(await instances.versionTags("acme", "bu")).toEqual({ "1.0.0": ["baseline"] });
  });

  it("missing/deleted versions → NotFound; deleted versions are also excluded from versionTags reads", async () => {
    await expect(instances.setVersionTags("acme", "bu", "9.9.9", ["x"])).rejects.toBeInstanceOf(NotFoundError);
    await instances.setVersionTags("acme", "bu", "1.0.0", ["baseline"]);
    await instances.softDelete("acme", "bu", "1.0.0");
    expect(await instances.versionTags("acme", "bu")).toEqual({});
    await expect(instances.setVersionTags("acme", "bu", "1.0.0", ["y"])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("resolveWithPins — submit-time transient pins (registry unchanged)", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;
  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", buTemplate);
    await instances.register("acme", instance("v1", { planner: "p:1", browser: "b:1" }));
  });

  it("merges transient pins over the instance pins and resolves, leaving the stored version/pins unchanged", async () => {
    const resolved = await instances.resolveWithPins("acme", "bu", "v1", { planner: "p:pr-7" });
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.map((s) => s.image)).toEqual(["p:pr-7", "b:1"]); // only planner swapped
    expect(await instances.versions("acme", "bu")).toEqual(["v1"]); // no new version (registry unchanged)
    const stored = await instances.get("acme", "bu", "v1");
    if (stored.kind !== "service") throw new Error("expected service");
    expect(stored.services.map((s) => s.image)).toEqual(["p:1", "b:1"]); // stored copy stays original
  });

  it("unknown slot pin → BadRequestError (silently ignoring a typo lets it pass without the PR image swapped)", async () => {
    await expect(instances.resolveWithPins("acme", "bu", "v1", { nope: "x" })).rejects.toBeInstanceOf(BadRequestError);
  });
});
