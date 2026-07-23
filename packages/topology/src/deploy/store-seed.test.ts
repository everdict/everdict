import { BadRequestError, type TopologyDependency } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type StoreSeedPlan, buildReadExec, buildSeedExec, planStoreSeed } from "./store-seed.js";

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

describe("buildSeedExec", () => {
  const pgPlan = (over: Partial<StoreSeedPlan> = {}): StoreSeedPlan => ({
    store: "postgres",
    role: "world",
    isolateBy: "schema",
    slice: "run_run42",
    seed: { inline: "INSERT INTO t VALUES (1);" },
    format: "sql",
    ...over,
  });

  it("seeds postgres into the case schema slice via a single psql -c script", () => {
    const exec = buildSeedExec(pgPlan());
    expect(exec.store).toBe("postgres");
    expect(exec.argvs).toHaveLength(1);
    const argv = exec.argvs[0] ?? [];
    expect(argv[0]).toBe("psql");
    expect(argv).toContain("-c");
    const script = argv[argv.length - 1];
    expect(script).toContain('CREATE SCHEMA IF NOT EXISTS "run_run42"');
    expect(script).toContain('SET search_path TO "run_run42"');
    expect(script).toContain("INSERT INTO t VALUES (1);");
  });

  it("targets the given database (pool passes the tenant DB)", () => {
    const argv = buildSeedExec(pgPlan(), "tenant_acme").argvs[0] ?? [];
    expect(argv[argv.indexOf("-d") + 1]).toBe("tenant_acme");
  });

  it("seeds redis via a redis-cli stdin heredoc, substituting {prefix} with the key-prefix slice", () => {
    const exec = buildSeedExec(
      pgPlan({ store: "redis", isolateBy: "key-prefix", slice: "run-run42", seed: { inline: "SET {prefix}:k v" } }),
    );
    expect(exec.store).toBe("redis");
    const argv = exec.argvs[0] ?? [];
    expect(argv[0]).toBe("sh");
    const script = argv[argv.length - 1];
    expect(script).toContain("redis-cli <<");
    expect(script).toContain("SET run-run42:k v"); // {prefix} → the slice
  });

  it("rejects an artifact-ref seed (not supported yet)", () => {
    expect(() => buildSeedExec(pgPlan({ seed: { ref: "s3://x" } }))).toThrow(BadRequestError);
  });

  it("rejects a store kind that has no seed exec yet (minio)", () => {
    expect(() => buildSeedExec(pgPlan({ store: "minio", isolateBy: "object-prefix", slice: "runs/run42/" }))).toThrow(
      /not supported yet/,
    );
  });
});

describe("buildReadExec", () => {
  it("reads postgres via tuples-only psql scoped to the schema slice", () => {
    const argv = buildReadExec("postgres", "run_run42", "SELECT * FROM t");
    expect(argv[0]).toBe("psql");
    expect(argv).toContain("-t");
    expect(argv[argv.length - 1]).toBe('SET search_path TO "run_run42"; SELECT * FROM t');
  });

  it("reads postgres from the given database (pool)", () => {
    const argv = buildReadExec("postgres", "run_run42", "SELECT 1", "tenant_acme");
    expect(argv[argv.indexOf("-d") + 1]).toBe("tenant_acme");
  });

  it("reads redis via redis-cli, substituting {prefix}", () => {
    const argv = buildReadExec("redis", "run-run42", "GET {prefix}:k");
    expect(argv[0]).toBe("sh");
    expect(argv[argv.length - 1]).toContain("GET run-run42:k");
  });

  it("rejects an unsupported store kind (minio)", () => {
    expect(() => buildReadExec("minio", "runs/x/", "ls")).toThrow(/not supported yet/);
  });
});
