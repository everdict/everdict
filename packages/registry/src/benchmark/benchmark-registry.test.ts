import type { BenchmarkAdapterSpec } from "@everdict/datasets";
import { describe, expect, it } from "vitest";
import { InMemoryBenchmarkRegistry } from "./benchmark-registry.js";

const spec = (id: string, version: string, dataset = "me/x"): BenchmarkAdapterSpec => ({
  id,
  version,
  category: "qa",
  source: { kind: "huggingface", dataset, split: "test" },
  mapping: { idField: "id", taskField: "q", answerField: "a" },
});

describe("InMemoryBenchmarkRegistry (per-tenant benchmark recipes)", () => {
  it("tenant isolation: B cannot see a benchmark A registered", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("acme", spec("priv", "1.0.0"));
    expect((await r.get("acme", "priv")).id).toBe("priv");
    await expect(r.get("globex", "priv")).rejects.toThrow(/not found/);
    expect((await r.list("globex")).find((b) => b.id === "priv")).toBeUndefined();
  });

  it("_shared fallback: every tenant sees first-party benchmarks (tenant-owned takes precedence)", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("_shared", spec("gsm8k", "1.0.0", "openai/gsm8k"));
    await r.register("acme", spec("gsm8k", "2.0.0", "acme/custom")); // tenant overrides the same id
    expect((await r.get("globex", "gsm8k")).source).toMatchObject({ dataset: "openai/gsm8k" }); // _shared
    expect((await r.get("acme", "gsm8k")).source).toMatchObject({ dataset: "acme/custom" }); // owned takes precedence
  });

  it("immutable versions: same (id,version) with different content → CONFLICT, same content → no-op", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("acme", spec("b", "1.0.0", "a/one"));
    await r.register("acme", spec("b", "1.0.0", "a/one")); // identical → no-op
    await expect(r.register("acme", spec("b", "1.0.0", "a/two"))).rejects.toThrow(/immutable/);
    expect(await r.ownVersions("acme", "b")).toEqual(["1.0.0"]);
  });

  it("latest resolution + list (owned/shared labeling)", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("acme", spec("b", "1.0.0"));
    await r.register("acme", spec("b", "1.2.0"));
    expect((await r.get("acme", "b", "latest")).version).toBe("1.2.0");
    expect((await r.get("acme", "b")).version).toBe("1.2.0");
    const list = await r.list("acme");
    expect(list.find((x) => x.id === "b")).toEqual({ id: "b", owner: "acme", versions: ["1.0.0", "1.2.0"] });
  });
});
