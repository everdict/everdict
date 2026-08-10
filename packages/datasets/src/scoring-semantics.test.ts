import { describe, expect, it } from "vitest";
import { BENCHMARK_CATALOG, type BenchmarkAdapter } from "./catalog.js";

// arch-review 16 P2-8. A benchmark whose official evaluator cannot run here scores by approximation, and that
// fact has to be DATA. Everdict treats results as trust artifacts that travel — trends, exports, release
// reports — and every one of those surfaces reads structured fields and drops prose, so a proxy number
// eventually gets rendered as "the TREK score" by something that never saw the paragraph.
describe("benchmark scoring semantics — a proxy score says so in a field, not only in a sentence", () => {
  it("every adapter whose description admits an approximation declares it structurally", () => {
    const adapters: BenchmarkAdapter[] = Object.values(BENCHMARK_CATALOG);
    const admitsInProse = adapters.filter((a) => /judge-scored approximation|approximation:/i.test(a.description));
    expect(admitsInProse.length).toBeGreaterThan(0); // the guard is worthless if it matches nothing
    for (const adapter of admitsInProse) {
      expect(adapter.scoring?.kind, `${adapter.id} admits an approximation in prose only`).toBe("proxy");
      // An approximation that cannot say what it approximates is not a description of one.
      expect(adapter.scoring?.approximates, `${adapter.id} does not say what it approximates`).toBeTruthy();
      expect(adapter.scoring?.officialEvaluator, `${adapter.id} does not name the official evaluator`).toBeTruthy();
    }
  });

  it("no adapter claims `official` without being able to run one", () => {
    // Absence is UNSTATED, never comparability — the same absence discipline the scoring plane uses. What is
    // refused here is the other direction: claiming official while the description says otherwise.
    const adapters: BenchmarkAdapter[] = Object.values(BENCHMARK_CATALOG);
    for (const adapter of adapters) {
      if (adapter.scoring?.kind !== "official") continue;
      expect(/approximation/i.test(adapter.description), `${adapter.id} claims official yet describes a proxy`).toBe(
        false,
      );
    }
  });
});
