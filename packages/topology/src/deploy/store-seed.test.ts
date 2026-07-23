import { BadRequestError, type TopologyDependency } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { planStoreSeed } from "./store-seed.js";

// Build a dependency with sensible defaults; override per test.
function dep(over: Partial<TopologyDependency> & Pick<TopologyDependency, "store">): TopologyDependency {
  return {
    role: "main",
    purpose: "data",
    isolateBy: "schema",
    ...over,
  };
}

const RUN = "run42";

describe("planStoreSeed", () => {
  it("binds a fixture to a purpose:data store and resolves the per-case schema slice", () => {
    const plans = planStoreSeed(
      [{ store: "postgres", seed: { inline: "INSERT INTO t VALUES (1);" } }],
      [dep({ store: "postgres", role: "world", isolateBy: "schema" })],
      RUN,
    );
    expect(plans).toEqual([
      {
        store: "postgres",
        role: "world",
        isolateBy: "schema",
        slice: "run_run42",
        seed: { inline: "INSERT INTO t VALUES (1);" },
        format: "sql",
      },
    ]);
  });

  it("defaults the seed format from the store kind (redis→redis-cmds, minio→objects)", () => {
    const redis = planStoreSeed(
      [{ store: "redis", seed: { inline: "SET k v" } }],
      [dep({ store: "redis", isolateBy: "key-prefix" })],
      RUN,
    );
    expect(redis[0]?.format).toBe("redis-cmds");
    expect(redis[0]?.slice).toBe("run-run42");

    const minio = planStoreSeed(
      [{ store: "minio", seed: { ref: "s3://fixtures/x.tar" } }],
      [dep({ store: "minio", isolateBy: "object-prefix" })],
      RUN,
    );
    expect(minio[0]?.format).toBe("objects");
    expect(minio[0]?.slice).toBe("runs/run42/");
  });

  it("honors an explicit format override", () => {
    const plans = planStoreSeed(
      [{ store: "postgres", seed: { inline: "..." }, format: "sql" }],
      [dep({ store: "postgres" })],
      RUN,
    );
    expect(plans[0]?.format).toBe("sql");
  });

  it("disambiguates by role when two stores share a kind", () => {
    const plans = planStoreSeed(
      [{ store: "postgres", role: "world", seed: { inline: "x" } }],
      [
        dep({ store: "postgres", role: "checkpoints", purpose: "plumbing" }),
        dep({ store: "postgres", role: "world", purpose: "data" }),
      ],
      RUN,
    );
    expect(plans[0]?.role).toBe("world");
  });

  it("rejects a fixture that matches no declared dependency", () => {
    expect(() => planStoreSeed([{ store: "redis", seed: { inline: "x" } }], [dep({ store: "postgres" })], RUN)).toThrow(
      BadRequestError,
    );
  });

  it("rejects an ambiguous match (two of the kind, no role)", () => {
    expect(() =>
      planStoreSeed(
        [{ store: "postgres", seed: { inline: "x" } }],
        [dep({ store: "postgres", role: "a" }), dep({ store: "postgres", role: "b" })],
        RUN,
      ),
    ).toThrow(/disambiguate/);
  });

  it("rejects seeding a purpose:plumbing store (agent state, not task data)", () => {
    expect(() =>
      planStoreSeed(
        [{ store: "postgres", seed: { inline: "x" } }],
        [dep({ store: "postgres", purpose: "plumbing" })],
        RUN,
      ),
    ).toThrow(/plumbing/);
  });

  it("rejects seeding an external (BYO) store — no per-case isolation slice", () => {
    expect(() =>
      planStoreSeed(
        [{ store: "postgres", seed: { inline: "x" } }],
        [dep({ store: "postgres", isolateBy: "external" })],
        RUN,
      ),
    ).toThrow(/external/);
  });

  it("plans multiple fixtures", () => {
    const plans = planStoreSeed(
      [
        { store: "postgres", role: "db", seed: { inline: "a" } },
        { store: "minio", role: "files", seed: { ref: "r" } },
      ],
      [
        dep({ store: "postgres", role: "db", isolateBy: "schema" }),
        dep({ store: "minio", role: "files", isolateBy: "object-prefix" }),
      ],
      RUN,
    );
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.store)).toEqual(["postgres", "minio"]);
  });
});
