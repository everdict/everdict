import type { RunnerHostStatus } from "@everdict/self-hosted-runner";
import type { DesktopRunnerStatus, DesktopRunnersStatus, PairPayload } from "./bridge.js";
import type { RunnerConfigEntry } from "./config-store.js";
import type { RunnerTokens } from "./token-store.js";

// Supervises EVERY runner paired on this device (skill desktop D9 — a device may register as several independent runners,
// each its own rnr_ identity → the workspace's personal `self` pool). Each runner is one RunnerHost; adding runners is how a
// user widens their pool (per-runner concurrency stays 1 — the scorecard's own concurrency drives parallelism).
// No electron dependency (DI) — main wires in safeStorage / file IO / RunnerHost. Design: docs/architecture/desktop-app.md D3/D9.
export interface RunnerHostLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Legacy (pre-D9) single-runner pairing, read once for migration into the multi-runner store.
export interface LegacyPairing {
  token: string;
  runnerId?: string;
  apiUrl?: string;
}

export interface RunnerSupervisorDeps {
  loadTokens(): RunnerTokens;
  saveTokens(tokens: RunnerTokens): void; // throws on failure (e.g. safeStorage unavailable) — pair returns the error as-is
  clearTokens(): void;
  loadRunners(): RunnerConfigEntry[];
  saveRunners(runners: RunnerConfigEntry[]): void;
  // One-time migration of an older desktop's single pairing — returns it if present (the caller clears it via clearLegacy).
  loadLegacy(): LegacyPairing | null;
  clearLegacy(): void;
  makeHost(opts: {
    runnerId: string;
    token: string;
    apiUrl: string;
    onStatus: (s: RunnerHostStatus) => void;
  }): RunnerHostLike;
  defaultApiUrl: string;
  broadcast(status: DesktopRunnersStatus): void;
  log?: (msg: string) => void;
}

const OFF: RunnerHostStatus = { state: "off", activeJobs: 0, capabilities: [] };

interface RunnerEntry {
  host: RunnerHostLike;
  status: RunnerHostStatus;
  apiUrl: string;
  label?: string;
}

// Pairing without a server-assigned runnerId is a degenerate (headless/manual) case — key it under a stable placeholder so it
// still runs (a second unnamed pairing simply replaces it). The web one-click always supplies the real runnerId.
const UNNAMED = "runner";

function upsertRunner(runners: RunnerConfigEntry[], entry: RunnerConfigEntry): RunnerConfigEntry[] {
  return [...runners.filter((r) => r.runnerId !== entry.runnerId), entry];
}

export class RunnerSupervisor {
  private readonly entries = new Map<string, RunnerEntry>();

  constructor(private readonly deps: RunnerSupervisorDeps) {}

  // On app startup — migrate any legacy pairing, then silently restore every saved runner. No runners = broadcast the empty status.
  async startFromStore(): Promise<void> {
    this.migrateLegacy();
    const tokens = this.deps.loadTokens();
    for (const runner of this.deps.loadRunners()) {
      const token = tokens[runner.runnerId];
      if (token === undefined) continue; // config entry with no matching token (keychain lost) — skip; the user re-pairs
      await this.startRunner(runner.runnerId, token, runner.apiUrl ?? this.deps.defaultApiUrl, runner.label);
    }
    this.emit();
  }

  // One-click pairing — additive. The token goes to the keychain (map) only; meta (runnerId/apiUrl) to the config file. A re-pair of
  // the same runnerId replaces just that runner's host, leaving the others running.
  async pair(payload: PairPayload): Promise<void> {
    const runnerId = payload.runnerId ?? UNNAMED;
    // saveTokens may throw (safeStorage unavailable) — do so BEFORE mutating any in-memory/host state so a failure does not advance.
    this.deps.saveTokens({ ...this.deps.loadTokens(), [runnerId]: payload.token });
    this.deps.saveRunners(
      upsertRunner(this.deps.loadRunners(), {
        runnerId,
        ...(payload.apiUrl !== undefined ? { apiUrl: payload.apiUrl } : {}),
      }),
    );
    this.stopRunnerInBackground(runnerId);
    await this.startRunner(runnerId, payload.token, payload.apiUrl ?? this.deps.defaultApiUrl);
  }

  // Unpair a specific runner (by id) or, when omitted, all runners on this device. Discards the token/meta immediately + broadcasts;
  // stopping the host(s) runs in the background (does not wait for an idle long-poll — the server-side token was already revoked by the web).
  async unpair(runnerId?: string): Promise<void> {
    if (runnerId === undefined) {
      this.deps.clearTokens();
      this.deps.saveRunners([]);
      for (const id of [...this.entries.keys()]) this.stopRunnerInBackground(id);
      this.emit();
      return;
    }
    const tokens = this.deps.loadTokens();
    delete tokens[runnerId];
    if (Object.keys(tokens).length === 0) this.deps.clearTokens();
    else this.deps.saveTokens(tokens);
    this.deps.saveRunners(this.deps.loadRunners().filter((r) => r.runnerId !== runnerId));
    this.stopRunnerInBackground(runnerId);
    this.emit();
  }

  status(): DesktopRunnersStatus {
    const runners: DesktopRunnerStatus[] = [...this.entries.entries()].map(([runnerId, entry]) => ({
      paired: true,
      runnerId,
      state: entry.status.state,
      activeJobs: entry.status.activeJobs,
      capabilities: entry.status.capabilities,
    }));
    return { runners };
  }

  // Graceful stop on app quit (through reporting the in-flight job). Unlike unpair, it waits — for every runner.
  async shutdown(): Promise<void> {
    const hosts = [...this.entries.values()].map((e) => e.host);
    this.entries.clear();
    await Promise.all(hosts.map((h) => h.stop().catch(() => {})));
  }

  private migrateLegacy(): void {
    try {
      const legacy = this.deps.loadLegacy();
      if (legacy === null) return;
      const runnerId = legacy.runnerId ?? UNNAMED;
      const tokens = this.deps.loadTokens();
      if (tokens[runnerId] === undefined) this.deps.saveTokens({ ...tokens, [runnerId]: legacy.token });
      this.deps.saveRunners(
        upsertRunner(this.deps.loadRunners(), {
          runnerId,
          ...(legacy.apiUrl !== undefined ? { apiUrl: legacy.apiUrl } : {}),
        }),
      );
      this.deps.clearLegacy();
    } catch (e) {
      this.deps.log?.(`Legacy runner migration failed (ignored): ${e instanceof Error ? e.message : e}`);
    }
  }

  private async startRunner(runnerId: string, token: string, apiUrl: string, label?: string): Promise<void> {
    const host = this.deps.makeHost({
      runnerId,
      token,
      apiUrl,
      onStatus: (s) => {
        const entry = this.entries.get(runnerId);
        if (entry === undefined) return; // stopped between the poll and this callback — drop the stale status
        entry.status = s;
        this.emit();
      },
    });
    this.entries.set(runnerId, { host, status: OFF, apiUrl, ...(label !== undefined ? { label } : {}) });
    await host.start();
  }

  private stopRunnerInBackground(runnerId: string): void {
    const entry = this.entries.get(runnerId);
    if (entry === undefined) return;
    this.entries.delete(runnerId);
    void entry.host
      .stop()
      .catch((e) => this.deps.log?.(`Runner stop failed (ignored): ${e instanceof Error ? e.message : e}`));
  }

  private emit(): void {
    this.deps.broadcast(this.status());
  }
}
