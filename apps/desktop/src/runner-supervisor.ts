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
  // The hostname this device can currently reach the server on — the URL the desktop loads the web from (main.ts wires
  // the live webUrl). Used to self-heal a runner whose stored control-plane URL is an internal host — a loopback, or the
  // server's own container/compose name (`api:8787`) — that a runner on this device can't dial (→ permanently offline,
  // the #1 "won't connect" cause). Optional: absent for the CLI / tests (no healing); a return of undefined means the
  // server URL isn't known yet (also no healing).
  reachableHost?: () => string | undefined;
  broadcast(status: DesktopRunnersStatus): void;
  log?: (msg: string) => void;
}

const OFF: RunnerHostStatus = { state: "off", activeJobs: 0, capabilities: [] };

// Loopback hosts a pairing may have baked into a runner's control-plane URL — reachable from the server host itself but
// NOT from a runner on another machine. Kept in sync with the web's resolveRunnerApiUrl LOOPBACK_HOSTNAMES set.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

// A control-plane host reachable only from the server itself, never from a runner on another machine: loopback, OR a
// single-label hostname (no dot) — a container/compose service name like `api` that the web reports (e.g. the compose
// `http://api:8787`) when IT reaches the CP over the deploy network. Both must be rebased onto the host this device can
// actually reach the server on. A real FQDN or IP literal (has a dot, or a bracketed IPv6) is an intentional public
// origin and is NEVER rewritten. Kept in concept-sync with the web's resolveRunnerApiUrl.isInternalHost.
function isInternalHost(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return !hostname.includes(".") && !hostname.startsWith("[");
}

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
      // Self-heal a loopback URL baked in at pair time on a different machine, so a just-updated app comes back online on
      // launch with no user action (the same rebase reconnect / repoint do — see healApiUrl). Persist the change so it sticks.
      const current = runner.apiUrl ?? this.deps.defaultApiUrl;
      const healed = this.healApiUrl(current);
      if (healed !== current) {
        this.deps.saveRunners(upsertRunner(this.deps.loadRunners(), { ...runner, apiUrl: healed }));
      }
      await this.startRunner(runner.runnerId, token, healed, runner.label, runner.maxConcurrent);
    }
    this.emit();
  }

  // One-click pairing — additive. The token goes to the keychain (map) only; meta (runnerId/apiUrl) to the config file. A re-pair of
  // the same runnerId replaces just that runner's host, leaving the others running.
  async pair(payload: PairPayload): Promise<void> {
    const runnerId = payload.runnerId ?? UNNAMED;
    // The web reports the control-plane URL from ITS vantage — often the server's own internal address (a `api:8787`
    // container/compose service name, or a loopback), which a runner on this device can't dial. Rebase it, at pair time,
    // onto the host the user configured the desktop to reach the server on (reachableHost), so the runner honors the
    // server address the user set instead of being born permanently offline. No-op when there's no incoming URL, no
    // configured host, single-machine dev, or the URL is already a real public origin; startup/reconnect heal the same.
    const apiUrl = payload.apiUrl === undefined ? undefined : this.healApiUrl(payload.apiUrl);
    // saveTokens may throw (safeStorage unavailable) — do so BEFORE mutating any in-memory/host state so a failure does not advance.
    this.deps.saveTokens({ ...this.deps.loadTokens(), [runnerId]: payload.token });
    this.deps.saveRunners(
      upsertRunner(this.deps.loadRunners(), {
        runnerId,
        ...(apiUrl !== undefined ? { apiUrl } : {}),
        ...(payload.maxConcurrent !== undefined ? { maxConcurrent: payload.maxConcurrent } : {}),
      }),
    );
    this.stopRunnerInBackground(runnerId);
    await this.startRunner(
      runnerId,
      payload.token,
      apiUrl ?? this.deps.defaultApiUrl,
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
  // FIRST self-heals a stale loopback URL: reconnect is the button a user actually reaches for, so if the stored apiUrl is a
  // loopback baked in at pair time on another machine (permanently unreachable → a plain restart would just fail again), it
  // is rebased onto the reachable server host so the reconnect actually recovers it. Then: a live host still dialing a
  // reachable URL is restarted in place (fresh MCP session → re-advertise → lease → lastSeenAt refreshes — no host swap, no
  // status race); a runner whose URL had to change, or that has no live host (e.g. its token was recovered after a keychain
  // loss that made startFromStore skip it), is (re)built on the healed URL from the stored token; a still-tokenless runner
  // can't be recovered here (the row must be re-paired) and is skipped.
  async reconnect(runnerId?: string): Promise<void> {
    const targets =
      runnerId !== undefined
        ? [runnerId]
        : [...new Set([...this.entries.keys(), ...this.deps.loadRunners().map((r) => r.runnerId)])];
    const tokens = this.deps.loadTokens();
    for (const id of targets) {
      const entry = this.entries.get(id);
      const cfg = this.deps.loadRunners().find((r) => r.runnerId === id);
      const current = entry?.apiUrl ?? cfg?.apiUrl ?? this.deps.defaultApiUrl;
      const healed = this.healApiUrl(current);
      // Persist a healed URL so it sticks (survives the next restart) — only when there's a config row to update.
      if (healed !== current && cfg !== undefined) {
        this.deps.saveRunners(upsertRunner(this.deps.loadRunners(), { ...cfg, apiUrl: healed }));
      }
      // A live host already dialing a reachable URL only needs a cheap in-place restart (no host swap → no status race).
      if (entry !== undefined && healed === current) {
        await entry.host.restart();
        continue;
      }
      // The URL had to be healed, or there is no live host → (re)build the host on the healed URL. Needs the token; a
      // healed live host whose token can't be recovered falls back to an in-place restart (best effort, keeps the old URL).
      const token = tokens[id];
      if (token === undefined) {
        if (entry !== undefined) await entry.host.restart();
        continue; // no live host AND no token — nothing to reconnect; the row must be re-paired
      }
      this.stopRunnerInBackground(id);
      await this.startRunner(id, token, healed, entry?.label ?? cfg?.label, cfg?.maxConcurrent);
    }
    this.emit();
  }

  // Rebase a stored control-plane URL whose host is internal (loopback, or a container/compose service name like `api`
  // the server reports for itself) onto the host this device can actually reach the server on (the URL it loaded the web
  // from), keeping the CP port/path — the same rebase repoint / the web's resolveRunnerApiUrl do, but AUTOMATIC and only
  // for an internal host (a real FQDN/IP is never rewritten). Returns the URL unchanged when there's no reachable host,
  // the reachable host is itself loopback (genuine single-machine dev), or the stored URL is already a real public origin.
  private healApiUrl(url: string): string {
    const host = this.deps.reachableHost?.();
    if (host === undefined || LOOPBACK_HOSTNAMES.has(host)) return url;
    try {
      const u = new URL(url);
      if (!isInternalHost(u.hostname)) return url;
      u.hostname = host;
      return u.toString().replace(/\/+$/, "");
    } catch {
      return url; // unparseable stored URL — leave it (re-pair to reset)
    }
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
