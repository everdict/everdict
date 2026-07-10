import { repinHarnessImages } from "@everdict/application-control";
import { BadRequestError, type HarnessTemplateSpec } from "@everdict/core";
import { InMemoryHarnessInstanceRegistry, InMemoryHarnessTemplateRegistry } from "@everdict/registry";
import { beforeEach, describe, expect, it } from "vitest";

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

describe("repinHarnessImages — durable re-pin (headless re-pin)", () => {
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

  it("tag pins are rejected by default (digest enforced) — allowed only with allowTags:true", async () => {
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

  it("a semver base version registers a new version via patch bump and merges over the base pins", async () => {
    await seed("1.0.0");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "c") },
      allowTags: false,
    });
    expect(result).toMatchObject({ id: "bu", version: "1.0.1", base: "1.0.0", unchanged: false });
    expect(result.pins).toEqual({ planner: digest("planner", "c"), browser: digest("browser", "b") }); // browser kept
    const resolved = await instances.get("acme", "bu", "1.0.1");
    if (resolved.kind !== "service") throw new Error("expected service");
    expect(resolved.services.find((s) => s.name === "planner")?.image).toBe(digest("planner", "c"));
  });

  it("re-requesting the same pin is unchanged (idempotent) — creates no new version", async () => {
    await seed("1.0.0");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "a") }, // same as the base
      allowTags: false,
    });
    expect(result).toMatchObject({ version: "1.0.0", unchanged: true });
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0"]);
  });

  it("a non-semver base version bumps with a -r<n> suffix", async () => {
    await seed("pr-1");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "d") },
      allowTags: false,
    });
    expect(result.version).toBe("pr-1-r2");
  });

  it("an explicit version (dev-<sha>) takes precedence over the auto bump", async () => {
    await seed("1.0.0");
    const result = await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "e") },
      version: "dev-abc1234",
      allowTags: false,
    });
    expect(result.version).toBe("dev-abc1234");
    expect(await instances.has("acme", "bu", "dev-abc1234")).toBe(true);
  });

  it("monorepo: multiple slots in one call → exactly one new version", async () => {
    await seed("1.0.0");
    await repinHarnessImages(instances, "acme", "ci", "bu", {
      pins: { planner: digest("planner", "f"), browser: digest("browser", "0") },
      allowTags: false,
    });
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0", "1.0.1"]);
  });

  it("unknown slot → BadRequest, nothing is registered", async () => {
    await seed("1.0.0");
    await expect(
      repinHarnessImages(instances, "acme", "ci", "bu", {
        pins: { nope: digest("nope", "1") },
        allowTags: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0"]); // nothing registered
  });
});
