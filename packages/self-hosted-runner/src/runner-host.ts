import type { AgentJob, CaseResult } from "@everdict/core";
import { detectCapabilities } from "./capabilities.js";
import { runLeasedJob } from "./run-leased-job.js";
import { runLeaseWorkers } from "./runner-loop.js";
import { type ConnectClient, ResilientMcpSession, mcpConnect } from "./runner-session.js";

// A runner facade for GUI embedding — wraps the lease loop with start/stop/status events (consumed by the desktop main process).
// The CLI uses runLeaseWorkers directly; desktop uses this facade — the execution behavior itself is identical (runLeasedJob).
// Design: docs/architecture/desktop-app.md.
export type RunnerHostState = "off" | "idle" | "running";

export interface RunnerHostStatus {
  state: RunnerHostState;
  activeJobs: number;
  capabilities: string[];
}

// Completion notice for one job — consumed by the GUI (OS notifications etc.). On failure it carries error, on success result.
export interface RunnerJobDone {
  job: AgentJob;
  result?: CaseResult;
  error?: Error;
}

export interface RunnerHostOpts {
  apiUrl: string; // control-plane base URL — append /mcp to connect
  token: string; // rnr_ pairing token
  maxConcurrent?: number; // default 1 (same as the CLI default)
  waitMs?: number; // lease long-poll wait (default 25s)
  heartbeatMs?: number; // lease renewal interval while running (default 30s)
  pollMs?: number; // lease error backoff (default 2s)
  capabilities?: string[]; // unset → detectCapabilities()
  onStatus?: (status: RunnerHostStatus) => void;
  onJobDone?: (done: RunnerJobDone) => void; // job completion notice (success/failure) — OS notifications etc.
  log?: (msg: string) => void;
  // Test injection points
  connect?: ConnectClient; // default mcpConnect(new URL("/mcp", apiUrl), token)
  runJob?: (job: AgentJob) => Promise<CaseResult>; // default runLeasedJob
  detect?: () => Promise<string[]>; // default detectCapabilities
  sleep?: (ms: number) => Promise<void>;
}

export class RunnerHost {
  private stopFlag = false;
  private loop: Promise<void> | null = null;
  private session: ResilientMcpSession | null = null;
  private activeJobs = 0;
  private capabilities: string[] = [];

  constructor(private readonly opts: RunnerHostOpts) {}

  status(): RunnerHostStatus {
    const state: RunnerHostState = this.loop === null ? "off" : this.activeJobs > 0 ? "running" : "idle";
    return { state, activeJobs: this.activeJobs, capabilities: this.capabilities };
  }

  // Idempotent start — no-op if already running. An initial connection failure isn't thrown since the loop retries with backoff.
  async start(): Promise<void> {
    if (this.loop) return;
    this.stopFlag = false;
    this.capabilities = this.opts.capabilities ?? (await (this.opts.detect ?? detectCapabilities)());
    const session = new ResilientMcpSession(
      this.opts.connect ?? mcpConnect(new URL("/mcp", this.opts.apiUrl), this.opts.token),
    );
    this.session = session;

    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await session.call(name, args);
      if (r.isError) throw new Error(r.text || `${name} failed`);
      return JSON.parse(r.text) as Record<string, unknown>;
    };
    // An image-case runs on local Docker (DockerDriver) when this runner has Docker — pass dockerAvailable from the capabilities.
    const dockerAvailable = this.capabilities.includes("docker");
    const baseRun = this.opts.runJob ?? ((job: AgentJob) => runLeasedJob(job, { dockerAvailable, log: this.opts.log }));
    // Wrap job start/finish to track activeJobs (the basis for running/idle events) + emit a completion notice.
    const runJob = async (job: AgentJob): Promise<CaseResult> => {
      this.activeJobs++;
      this.emit();
      try {
        const result = await baseRun(job);
        this.opts.onJobDone?.({ job, result });
        return result;
      } catch (e) {
        this.opts.onJobDone?.({ job, error: e instanceof Error ? e : new Error(String(e)) });
        throw e; // keep the existing path where the loop replies via fail_job
      } finally {
        this.activeJobs--;
        this.emit();
      }
    };

    this.loop = runLeaseWorkers(
      { callJson, runJob, log: this.opts.log, sleep: this.opts.sleep },
      {
        maxConcurrent: Math.max(1, this.opts.maxConcurrent ?? 1),
        waitMs: this.opts.waitMs ?? 25_000,
        heartbeatMs: this.opts.heartbeatMs ?? 30_000,
        pollMs: this.opts.pollMs ?? 2_000,
        capabilities: this.capabilities,
        shouldStop: () => this.stopFlag,
      },
    ).finally(() => {
      this.loop = null;
      this.emit();
    });
    this.emit();
  }

  // Graceful stop — in-flight jobs run to completion and reply; idle workers drop out once the current long-poll (≤waitMs) ends.
  async stop(): Promise<void> {
    this.stopFlag = true;
    const loop = this.loop;
    if (loop) await loop.catch(() => {});
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  private emit(): void {
    this.opts.onStatus?.(this.status());
  }
}
