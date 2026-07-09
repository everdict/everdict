// Zero-dependency Prometheus metrics registry (text exposition format 0.0.4) — the time-series half of
// scheduler observability. /queue answers "what is happening NOW"; this answers "since when, how often, how
// long" (queue depth over time, per-runtime latency percentiles, breaker trip rates) via any Prometheus scrape.
// Counters/histograms are instrumented at the dispatch seam; gauges are sampled from live components at scrape.
// Hand-rolled on purpose: the repo avoids a dependency where 100 lines of spec-conformant text output will do.

const ESCAPE = /(["\\\n])/g;
function labelStr(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const body = entries.map(([k, v]) => `${k}="${v.replace(ESCAPE, (c) => (c === "\n" ? "\\n" : `\\${c}`))}"`).join(",");
  return `{${body}}`;
}

// Default duration buckets (seconds) — eval cases run seconds to tens of minutes.
const DURATION_BUCKETS = [1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];

interface HistogramState {
  buckets: number[]; // cumulative counts aligned to DURATION_BUCKETS
  sum: number;
  count: number;
}

export class Metrics {
  private readonly counters = new Map<string, { help: string; series: Map<string, number> }>();
  private readonly histograms = new Map<string, { help: string; series: Map<string, HistogramState> }>();
  private readonly gaugeSources: Array<{
    name: string;
    help: string;
    sample: () => Array<{ labels: Record<string, string>; value: number }>;
  }> = [];

  counter(name: string, help: string, labels: Record<string, string> = {}, delta = 1): void {
    let c = this.counters.get(name);
    if (!c) {
      c = { help, series: new Map() };
      this.counters.set(name, c);
    }
    const key = labelStr(labels);
    c.series.set(key, (c.series.get(key) ?? 0) + delta);
  }

  observe(name: string, help: string, labels: Record<string, string>, valueSeconds: number): void {
    let h = this.histograms.get(name);
    if (!h) {
      h = { help, series: new Map() };
      this.histograms.set(name, h);
    }
    const key = labelStr(labels);
    let s = h.series.get(key);
    if (!s) {
      s = { buckets: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      h.series.set(key, s);
    }
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      const bucket = DURATION_BUCKETS[i] as number;
      if (valueSeconds <= bucket) s.buckets[i] = (s.buckets[i] as number) + 1;
    }
    s.sum += valueSeconds;
    s.count += 1;
  }

  // Live-sampled gauge — the sample fn runs at scrape time (scheduler stats, breaker states, …).
  gauge(name: string, help: string, sample: () => Array<{ labels: Record<string, string>; value: number }>): void {
    this.gaugeSources.push({ name, help, sample });
  }

  render(): string {
    const out: string[] = [];
    for (const { name, help, sample } of this.gaugeSources) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      let rows: Array<{ labels: Record<string, string>; value: number }> = [];
      try {
        rows = sample();
      } catch {
        // a broken sampler must not take the whole scrape down
      }
      for (const r of rows) out.push(`${name}${labelStr(r.labels)} ${r.value}`);
    }
    for (const [name, c] of this.counters) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [key, value] of c.series) out.push(`${name}${key} ${value}`);
    }
    for (const [name, h] of this.histograms) {
      out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
      for (const [key, s] of h.series) {
        // key is "{a=\"b\"}" or "" — merge the le label into the existing set.
        const open = key === "" ? "{" : `${key.slice(0, -1)},`;
        for (let i = 0; i < DURATION_BUCKETS.length; i++) {
          out.push(`${name}_bucket${open}le="${DURATION_BUCKETS[i]}"} ${s.buckets[i]}`);
        }
        out.push(`${name}_bucket${open}le="+Inf"} ${s.count}`);
        out.push(`${name}_sum${key} ${s.sum}`);
        out.push(`${name}_count${key} ${s.count}`);
      }
    }
    return `${out.join("\n")}\n`;
  }
}
