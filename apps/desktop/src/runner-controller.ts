import type { RunnerHostStatus } from "@everdict/self-hosted-runner";
import type { DesktopRunnerStatus, PairPayload } from "./bridge.js";

// Runner lifecycle controller — persists pair state (token/meta) + starts/stops the RunnerHost + broadcasts status.
// No electron dependency (DI) — main wires in safeStorage / file IO / RunnerHost. Design: docs/architecture/desktop-app.md D3.
export interface RunnerHostLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RunnerMeta {
  runnerId?: string;
  apiUrl?: string;
}

export interface RunnerControllerDeps {
  loadToken(): string | null;
  saveToken(token: string): void; // throws on failure (e.g. safeStorage unavailable) — pair returns the error as-is
  clearToken(): void;
  loadMeta(): RunnerMeta;
  saveMeta(meta: RunnerMeta): void;
  makeHost(opts: { token: string; apiUrl: string; onStatus: (s: RunnerHostStatus) => void }): RunnerHostLike;
  defaultApiUrl: string;
  broadcast(status: DesktopRunnerStatus): void;
  log?: (msg: string) => void;
}

const OFF: RunnerHostStatus = { state: "off", activeJobs: 0, capabilities: [] };

export class RunnerController {
  private host: RunnerHostLike | null = null;
  private hostStatus: RunnerHostStatus = OFF;
  private paired = false;
  private runnerId: string | undefined;

  constructor(private readonly deps: RunnerControllerDeps) {}

  // On app startup — if a saved token exists, silently start restoring the runner. No token = broadcast the unpaired status only.
  async startFromStore(): Promise<void> {
    const token = this.deps.loadToken();
    const meta = this.deps.loadMeta();
    this.runnerId = meta.runnerId;
    if (token === null) {
      this.emit();
      return;
    }
    this.paired = true;
    await this.startHost(token, meta.apiUrl ?? this.deps.defaultApiUrl);
  }

  // One-click pairing — the token goes to the keychain only, and the meta (runnerId/apiUrl) to the config file. Any existing host is cleaned up in the background.
  async pair(payload: PairPayload): Promise<void> {
    this.deps.saveToken(payload.token);
    const meta: RunnerMeta = {
      ...(payload.runnerId !== undefined ? { runnerId: payload.runnerId } : {}),
      ...(payload.apiUrl !== undefined ? { apiUrl: payload.apiUrl } : {}),
    };
    this.deps.saveMeta(meta);
    this.runnerId = payload.runnerId;
    this.paired = true;
    this.stopHostInBackground();
    await this.startHost(payload.token, payload.apiUrl ?? this.deps.defaultApiUrl);
  }

  // Unpair — discard the token/meta immediately + broadcast off. Stopping the host runs in the background (does not wait for an idle long-poll ≤waitMs;
  // the server-side token was already invalidated by the web's revoke, so any later lease is rejected anyway).
  async unpair(): Promise<void> {
    this.deps.clearToken();
    this.deps.saveMeta({});
    this.paired = false;
    this.runnerId = undefined;
    this.hostStatus = OFF;
    this.stopHostInBackground();
    this.emit();
  }

  status(): DesktopRunnerStatus {
    return {
      paired: this.paired,
      ...(this.runnerId !== undefined ? { runnerId: this.runnerId } : {}),
      state: this.hostStatus.state,
      activeJobs: this.hostStatus.activeJobs,
      capabilities: this.hostStatus.capabilities,
    };
  }

  // Graceful stop on app quit (through reporting the in-flight job). Unlike unpair, it waits.
  async shutdown(): Promise<void> {
    const h = this.host;
    this.host = null;
    if (h) await h.stop().catch(() => {});
  }

  private async startHost(token: string, apiUrl: string): Promise<void> {
    const host = this.deps.makeHost({
      token,
      apiUrl,
      onStatus: (s) => {
        this.hostStatus = s;
        this.emit();
      },
    });
    this.host = host;
    await host.start();
  }

  private stopHostInBackground(): void {
    const h = this.host;
    this.host = null;
    if (h)
      void h
        .stop()
        .catch((e) => this.deps.log?.(`Runner stop failed (ignored): ${e instanceof Error ? e.message : e}`));
  }

  private emit(): void {
    this.deps.broadcast(this.status());
  }
}
