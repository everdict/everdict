import { describe, expect, it } from "vitest";
import { Metrics } from "./metrics.js";

describe("Metrics — Prometheus text exposition", () => {
  it("renders counters with labels and accumulates deltas per series", () => {
    const m = new Metrics();
    m.counter("everdict_dispatch_total", "Dispatch outcomes.", { runtime: "nomad", outcome: "ok" });
    m.counter("everdict_dispatch_total", "Dispatch outcomes.", { runtime: "nomad", outcome: "ok" });
    m.counter("everdict_dispatch_total", "Dispatch outcomes.", { runtime: "kind", outcome: "infra" });
    const out = m.render();
    expect(out).toContain("# TYPE everdict_dispatch_total counter");
    expect(out).toContain('everdict_dispatch_total{runtime="nomad",outcome="ok"} 2');
    expect(out).toContain('everdict_dispatch_total{runtime="kind",outcome="infra"} 1');
  });

  it("renders histograms with cumulative buckets, +Inf, sum and count", () => {
    const m = new Metrics();
    m.observe("everdict_case_duration_seconds", "Case duration.", { runtime: "nomad" }, 4);
    m.observe("everdict_case_duration_seconds", "Case duration.", { runtime: "nomad" }, 40);
    const out = m.render();
    expect(out).toContain('everdict_case_duration_seconds_bucket{runtime="nomad",le="2.5"} 0');
    expect(out).toContain('everdict_case_duration_seconds_bucket{runtime="nomad",le="5"} 1');
    expect(out).toContain('everdict_case_duration_seconds_bucket{runtime="nomad",le="60"} 2');
    expect(out).toContain('everdict_case_duration_seconds_bucket{runtime="nomad",le="+Inf"} 2');
    expect(out).toContain('everdict_case_duration_seconds_sum{runtime="nomad"} 44');
    expect(out).toContain('everdict_case_duration_seconds_count{runtime="nomad"} 2');
  });

  it("gauges sample live at render time, and a broken sampler never takes the scrape down", () => {
    const m = new Metrics();
    let queued = 3;
    m.gauge("everdict_scheduler_queued", "Queued jobs.", () => [{ labels: {}, value: queued }]);
    m.gauge("everdict_broken", "Broken sampler.", () => {
      throw new Error("sampler died");
    });
    expect(m.render()).toContain("everdict_scheduler_queued 3");
    queued = 7;
    const out = m.render();
    expect(out).toContain("everdict_scheduler_queued 7"); // re-sampled, not cached
    expect(out).toContain("# TYPE everdict_broken gauge"); // header survives, series simply absent
  });

  it("escapes label values (quotes, backslashes, newlines)", () => {
    const m = new Metrics();
    m.counter("everdict_test_total", "Escapes.", { name: 'a"b\\c\nd' });
    expect(m.render()).toContain('everdict_test_total{name="a\\"b\\\\c\\nd"} 1');
  });
});
