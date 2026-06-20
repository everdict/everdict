import type { BenchmarkAdapterSpec } from "@assay/datasets";
import { describe, expect, it } from "vitest";
import { InMemoryBenchmarkRegistry } from "./benchmark-registry.js";

const spec = (id: string, version: string, dataset = "me/x"): BenchmarkAdapterSpec => ({
  id,
  version,
  category: "qa",
  source: { kind: "huggingface", dataset, split: "test" },
  mapping: { idField: "id", taskField: "q", answerField: "a" },
});

describe("InMemoryBenchmarkRegistry (테넌트별 벤치마크 레시피)", () => {
  it("테넌트 격리: A 가 등록한 벤치마크를 B 는 못 본다", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("acme", spec("priv", "1.0.0"));
    expect((await r.get("acme", "priv")).id).toBe("priv");
    await expect(r.get("globex", "priv")).rejects.toThrow(/없습니다/);
    expect((await r.list("globex")).find((b) => b.id === "priv")).toBeUndefined();
  });

  it("_shared 폴백: first-party 벤치마크는 모든 테넌트가 본다(테넌트 소유 우선)", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("_shared", spec("gsm8k", "1.0.0", "openai/gsm8k"));
    await r.register("acme", spec("gsm8k", "2.0.0", "acme/custom")); // 같은 id 를 테넌트가 오버라이드
    expect((await r.get("globex", "gsm8k")).source).toMatchObject({ dataset: "openai/gsm8k" }); // _shared
    expect((await r.get("acme", "gsm8k")).source).toMatchObject({ dataset: "acme/custom" }); // 소유 우선
  });

  it("버전 불변: 같은 (id,version) 다른 내용 → CONFLICT, 같은 내용 → no-op", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("acme", spec("b", "1.0.0", "a/one"));
    await r.register("acme", spec("b", "1.0.0", "a/one")); // 동일 → no-op
    await expect(r.register("acme", spec("b", "1.0.0", "a/two"))).rejects.toThrow(/불변/);
    expect(await r.ownVersions("acme", "b")).toEqual(["1.0.0"]);
  });

  it("latest 해석 + list(소유/공유 표기)", async () => {
    const r = new InMemoryBenchmarkRegistry();
    await r.register("acme", spec("b", "1.0.0"));
    await r.register("acme", spec("b", "1.2.0"));
    expect((await r.get("acme", "b", "latest")).version).toBe("1.2.0");
    expect((await r.get("acme", "b")).version).toBe("1.2.0");
    const list = await r.list("acme");
    expect(list.find((x) => x.id === "b")).toEqual({ id: "b", owner: "acme", versions: ["1.0.0", "1.2.0"] });
  });
});
