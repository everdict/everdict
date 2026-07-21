import type { RunnerHostStatus } from "@everdict/self-hosted-runner";
import type { DesktopRunnerStatus, DesktopRunnersStatus, PairPayload } from "./bridge.js";
import type { RunnerConfigEntry } from "./config-store.js";
import type { RunnerTokens } from "./token-store.js";

// Supervises EVERY runner paired on this device (skill desktop D9 — a device may register as several independent runners,
// each its own rnr_ identity → the workspace's personal `self` pool). Each runner is one RunnerHost. A user widens their pool
// on TWO composing axes: pairing more runners (D9), and each runner's per-runner concurrency (maxConcurrent, chosen at pair time →
// runLeaseWorkers spins that many worker loops so one runner leases + runs that many jobs in parallel). maxConcurrent is
// desktop-local (persisted in the config roster, never sent to the control plane) and defaults to 1 (the prior behavior).
// No electron dependency (DI) — main wires in safeStorage / file IO / RunnerHost. Design: docs/architecture/desktop-app.md D3/D9.
export interface RunnerHostLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Force a fresh reconnect on a running host (recovers a runner that shows offline) — see RunnerHost.restart.
  restart(): Promise<void>;
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
    maxConcurrent?: number; // this runner's worker-pool size (unset → the RunnerHost default of 1)
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
      await this.startRunner(
        runner.runnerId,
        token,
        runner.apiUrl ?? this.deps.defaultApiUrl,
        runner.label,
        runner.maxConcurrent,
      );
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
        ...(payload.maxConcurrent !== undefined ? { maxConcurrent: payload.maxConcurrent } : {}),
      }),
    );
    this.stopRunnerInBackground(runnerId);
    await this.startRunner(
      runnerId,
      payload.token,
      payload.apiUrl ?? this.deps.defaultApiUrl,
      undefined,
      payload.maxConcurrent,
    );
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

  // Force a paired runner (or, id omitted, every runner on this device) to reconnect — the recovery lever for a runner that
  // shows "offline" (its lease loop can't reach the control plane, so lastSeenAt goes stale) without discarding the pairing.
  // A live host is restarted in place (fresh MCP session → re-advertise → lease → lastSeenAt refreshes). A runner that has no
  // live host (e.g. its token was recovered after a keychain loss that made startFromStore skip it) is (re)started from the
  // stored token; a still-missing token can't be recovered here (the row must be re-paired) and is skipped.
  async reconnect(runnerId?: string): Promise<void> {
    const targets =
      runnerId !== undefined
        ? [runnerId]
        : [...new Set([...this.entries.keys(), ...this.deps.loadRunners().map((r) => r.runnerId)])];
    const tokens = this.deps.loadTokens();
    for (const id of targets) {
      const entry = this.entries.get(id);
      if (entry !== undefined) {
        await entry.host.restart();
        continue;
      }
      const token = tokens[id];
      const cfg = this.deps.loadRunners().find((r) => r.runnerId === id);
      if (token === undefined || cfg === undefined) continue; // keychain lost — can't reconnect; the row must be re-paired
      await this.startRunner(id, token, cfg.apiUrl ?? this.deps.defaultApiUrl, cfg.label, cfg.maxConcurrent);
    }
    this.emit();
  }

  // Repoint every runner's control-plane URL onto a new host (the user changed the server address in the tray) and
  // restart them — the fix for a runner stuck on an unreachable URL (e.g. a loopback baked in at pair time on a
  // different machine) WITHOUT a full unpair/re-pair. Only the hostname is swapped; each runner keeps its CP port/path
  // (the common case: the server moved hosts, same CP port). A malformed stored URL is left as-is. Persists first, then
  // restarts each host on its new URL.
  async repoint(host: string): Promise<void> {
    const rebased = this.deps.loadRunners().map((r) => {
      const current = r.apiUrl ?? this.deps.defaultApiUrl;
      try {
        const u = new URL(current);
        u.hostname = host;
        return { ...r, apiUrl: u.toString().replace(/\/+$/, "") };
      } catch {
        return r; // unparseable stored URL — leave it (re-pair to reset)
      }
    });
    this.deps.saveRunners(rebased);
    const tokens = this.deps.loadTokens();
    for (const r of rebased) {
      const token = tokens[r.runnerId];
      this.stopRunnerInBackground(r.runnerId);
      if (token === undefined) continue; // keychain lost — can't restart; the row must be re-paired
      await this.startRunner(r.runnerId, token, r.apiUrl ?? this.deps.defaultApiUrl, r.label, r.maxConcurrent);
    }
    this.emit();
  }

  status(): DesktopRunnersStatus {
    const runners: DesktopRunnerStatus[] = [...this.entries.entries()].map(([runnerId, entry]) => ({
      paired: true,
      runnerId,
      state: entry.status.state,
      activeJobs: entry.status.activeJobs,
      capabilities: entry.status.capabilities,
      // Carry the runner's local note (why it can/can't work — incl. a connect failure) + the URL it's dialing, so the
      // web surfaces WHY it's offline and can point out a wrong apiUrl.
      ...(entry.status.note ? { note: entry.status.note } : {}),
      apiUrl: entry.apiUrl,
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

  private async startRunner(
    runnerId: string,
    token: string,
    apiUrl: string,
    label?: string,
    maxConcurrent?: number,
  ): Promise<void> {
    const host = this.deps.makeHost({
      runnerId,
      token,
      apiUrl,
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
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
