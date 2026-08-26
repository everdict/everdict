import { repinHarnessImages } from "@everdict/application-control";
import type { HarnessTemplateSpec } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryHarnessInstanceRegistry } from "./harness-instance-registry.js";
import { InMemoryHarnessTemplateRegistry } from "./harness-template-registry.js";

// ── THE ANCESTRY IS IN HAND AND DROPPED AT THE WRITE (docs/architecture/evolution-lineage.md, Track A) ────
//
// `repinHarnessImages` computes the merge base, answers it to the caller in `RepinResult.base` — and then
// registered the successor with no origin, so "where did this version come from" had no durable answer and
// the graph's `succeeds` predicate had nothing to emit from. These counterexamples drive the PRODUCTION
// composition — the real service function over the real in-memory registry — per rule `testing`: a test that
// hands the service a deps bag of its own making cannot see a value the wire never carries.
//
// RED as of 689a8c8a: `expected undefined to deeply equal { via: 'ci', from: { type: 'harness', … } }` —
// the register call carried no origin, so `versionOrigins` had no entry for the re-pinned version.

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

const D = (c: string): string => `img@sha256:${c.repeat(64)}`;
const instance = (version: string, pins: Record<string, string>) => ({
  template: { id: "bu", version: "1" },
  id: "bu",
  version,
  pins,
});

async function originsOf(instances: InMemoryHarnessInstanceRegistry, version: string): Promise<unknown> {
  const entry = (await instances.list("acme")).find((e) => e.id === "bu");
  return entry?.versionOrigins?.[version];
}

describe("re-pin lineage — the ancestor is recorded by the write that knows it", () => {
  let templates: InMemoryHarnessTemplateRegistry;
  let instances: InMemoryHarnessInstanceRegistry;
  beforeEach(async () => {
    templates = new InMemoryHarnessTemplateRegistry();
    instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", template);
    await instances.register("acme", instance("1.0.0", { planner: D("a"), browser: D("b") }), "alice");
  });

  it("a re-pinned version records the merge base as its origin, at the write", async () => {
    const r = await repinHarnessImages(
      instances,
      "acme",
      "ci-bot",
      "bu",
      { pins: { planner: D("c") }, allowTags: false },
      { via: "ci" },
    );
    expect(r.unchanged).toBe(false);
    expect(r.base).toBe("1.0.0");
    expect(await originsOf(instances, r.version)).toEqual({
      via: "ci",
      from: { type: "harness", id: "bu", version: "1.0.0" },
      note: "re-pin: planner",
    });
  });

  it("the recorded ancestor is the base the caller pinned from, never the numerically previous version", async () => {
    // A second version exists; the re-pin explicitly bases on the OLD one. An implementation deriving
    // ancestry from version adjacency (semver order, registration order) reports 1.0.1 here and goes red —
    // provenance is born at the source, never re-derived from rendered output (rule `protocol` L3).
    await instances.register("acme", instance("1.0.1", { planner: D("d"), browser: D("b") }), "alice");
    const r = await repinHarnessImages(
      instances,
      "acme",
      "alice",
      "bu",
      { pins: { browser: D("e") }, base: "1.0.0", allowTags: false },
      { via: "web", note: "hotfix from the shipped base" },
    );
    expect(r.base).toBe("1.0.0");
    expect(await originsOf(instances, r.version)).toEqual({
      via: "web",
      from: { type: "harness", id: "bu", version: "1.0.0" },
      note: "hotfix from the shipped base", // a caller's stated reason wins over the synthesized summary
    });
  });

  it("a re-pinned version stays with the team that owns the harness (review wave C)", async () => {
    // Ownership belongs to the ENTITY (rule `registry`), and the entity's team is read off its newest own
    // version — so a successor registered with no team moves the whole harness out of its team's list the
    // moment it becomes latest. The re-pin knows the base; the base's team is the registry's own answer.
    // Seen RED: the successor's entry lost `teamId` entirely.
    const teamed = new InMemoryHarnessInstanceRegistry(templates);
    await teamed.register("acme", instance("1.0.0", { planner: D("a"), browser: D("b") }), "alice", "team-eng");
    const r = await repinHarnessImages(
      teamed,
      "acme",
      "ci-bot",
      "bu",
      { pins: { planner: D("c") }, allowTags: false },
      { via: "ci" },
    );
    expect(r.unchanged).toBe(false);
    const entry = (await teamed.list("acme")).find((e) => e.id === "bu");
    expect(entry?.latestVersion).toBe(r.version);
    expect(entry?.teamId).toBe("team-eng");
  });

  it("an unchanged re-pin registers nothing, so it mints no origin", async () => {
    const r = await repinHarnessImages(
      instances,
      "acme",
      "alice",
      "bu",
      { pins: { planner: D("a") }, allowTags: false },
      { via: "ci" },
    );
    expect(r.unchanged).toBe(true);
    expect(r.version).toBe("1.0.0");
    expect(await originsOf(instances, "1.0.0")).toBeUndefined();
  });
});
