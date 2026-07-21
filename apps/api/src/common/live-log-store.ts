// Live execution log per run (observability ②, self-hosted push path — the log twin of LiveFrameStore). A self-hosted
// runner has no channel the control plane can tail mid-run, so it PUSHES its per-case lifecycle lines (started /
// completed / failed [class/stage]: reason) here via the report_case_log MCP tool; RunService.logs() serves the
// accumulated text for that run. In-memory + TTL, keyed by the CP-minted runId (evd-run-<id> / evd-<batchId>-<caseId>).
// Single-node only — like the live frame store and the lease hub, live viewing does not survive a control-plane restart.
//
// Unlike a frame (a point-in-time snapshot that overwrites), a log is CUMULATIVE history, so entries append and the TTL
// is generous (a case can run for many minutes with sparse lines) — the entry lives well past the last line so a
// long-running case's log doesn't vanish between appends. A per-run ring cap bounds memory for a chatty run.
interface LiveLog {
  lines: string[];
  at: number; // last-append time (ms) — for TTL expiry
}

export class LiveLogStore {
  private readonly logs = new Map<string, LiveLog>();
  constructor(
    private readonly ttlMs = 900_000, // 15 min — cumulative history, kept for the whole (possibly long) run
    private readonly maxLines = 1000, // ring cap per run — a chatty run drops its oldest lines rather than grow unbounded
    private readonly now: () => number = () => Date.now(),
  ) {}

  // Append a line to a run's log (creating the entry on first line). Bounded to the newest maxLines.
  append(runId: string, line: string): void {
    let entry = this.logs.get(runId);
    if (!entry) {
      entry = { lines: [], at: this.now() };
      this.logs.set(runId, entry);
    }
    entry.lines.push(line);
    if (entry.lines.length > this.maxLines) entry.lines.splice(0, entry.lines.length - this.maxLines);
    entry.at = this.now();
    this.prune();
  }

  // The accumulated log text for a run (newline-joined), or undefined (never pushed / expired). Expired entries drop on read.
  get(runId: string): string | undefined {
    const e = this.logs.get(runId);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.logs.delete(runId);
      return undefined;
    }
    return e.lines.join("\n");
  }

  // Drop every entry older than the TTL — bounds the map when runs end without an explicit clear.
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.logs) if (v.at < cutoff) this.logs.delete(k);
  }
}
