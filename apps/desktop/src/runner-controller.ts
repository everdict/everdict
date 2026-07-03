import type { RunnerHostStatus } from "@assay/runner-core";
import type { DesktopRunnerStatus, PairPayload } from "./bridge.js";

// 러너 수명주기 컨트롤러 — 페어 상태(토큰/메타) 영속 + RunnerHost 시작/정지 + 상태 브로드캐스트.
// electron 미의존(DI) — main 이 safeStorage/파일 IO/RunnerHost 를 묶는다. 설계: docs/architecture/desktop-app.md D3.
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
  saveToken(token: string): void; // 실패(safeStorage 불가 등) 시 throw — pair 가 그대로 에러로 회신
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

  // 앱 기동 시 — 저장된 토큰이 있으면 러너를 조용히 복원 시작. 토큰 없음 = 미페어 상태 브로드캐스트만.
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

  // 원클릭 페어링 — 토큰은 keychain 으로만, 메타(runnerId/apiUrl)는 설정 파일로. 기존 호스트는 백그라운드 정리.
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

  // 해제 — 토큰/메타 즉시 폐기 + off 브로드캐스트. 호스트 정지는 백그라운드(유휴 long-poll ≤waitMs 를 기다리지 않는다;
  // 서버 쪽 토큰은 웹의 revoke 가 이미 무효화했으므로 이후 lease 는 어차피 거부된다).
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

  // 앱 종료 시 우아한 정지(진행 중 잡 회신까지). unpair 와 달리 기다린다.
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
    if (h) void h.stop().catch((e) => this.deps.log?.(`러너 정지 실패(무시): ${e instanceof Error ? e.message : e}`));
  }

  private emit(): void {
    this.deps.broadcast(this.status());
  }
}
