// 자동 업데이트 컨트롤러 — electron-updater 를 DI 로 감싼다(테스트는 가짜 emitter 주입).
// 정책(설계 D6, docs/architecture/desktop-app.md): 감지·다운로드는 자동, "적용"은 사용자 동의(트레이
// 재시작 항목) — 러너가 잡을 돌리는 중 강제 재시작하지 않는다. 피드 미구성(disabled)이면 전부 no-op:
// 피드 목적지(공개 releases 리포 vs 리포 public 전환)는 사용자 결정 대기 — main.ts 의 게이트 참고.
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export type UpdaterState =
  | { kind: "disabled" } // 피드 미구성 또는 미패키징(dev)
  | { kind: "idle" } // 활성 — 최신 상태(또는 아직 체크 전)
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent?: number }
  | { kind: "ready"; version: string } // 다운로드 완료 — 재시작하면 적용
  | { kind: "error"; message: string };

export interface UpdaterControllerOpts {
  updater: AutoUpdaterLike | null; // null → disabled
  intervalMs?: number; // 재체크 주기(기본 6시간)
  onStatus?: (state: UpdaterState) => void;
  log?: (msg: string) => void;
  // 테스트 주입점 — 기본 setInterval(+unref). 해제 함수를 돌려준다.
  schedule?: (fn: () => void, ms: number) => () => void;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export class UpdaterController {
  private current: UpdaterState = { kind: "disabled" };
  private stopSchedule: (() => void) | null = null;
  private started = false;

  constructor(private readonly opts: UpdaterControllerOpts) {}

  state(): UpdaterState {
    return this.current;
  }

  // 이벤트 배선 + 최초 체크 + 주기 재체크. 피드 미구성이면 no-op(상태 disabled 유지).
  start(): void {
    const u = this.opts.updater;
    if (!u || this.started) {
      this.emit(this.current);
      return;
    }
    this.started = true;
    u.autoDownload = true; // 감지 즉시 백그라운드 다운로드
    u.autoInstallOnAppQuit = true; // 사용자가 그냥 종료해도 다음 실행은 새 버전
    u.on("checking-for-update", () => this.set({ kind: "checking" }));
    u.on("update-available", (info: { version: string }) => this.set({ kind: "downloading", version: info.version }));
    u.on("download-progress", (progress: { percent: number }) => {
      if (this.current.kind === "downloading") this.set({ ...this.current, percent: Math.round(progress.percent) });
    });
    u.on("update-downloaded", (info: { version: string }) => this.set({ kind: "ready", version: info.version }));
    u.on("update-not-available", () => this.set({ kind: "idle" }));
    u.on("error", (err: Error) => {
      // 오프라인/피드 일시 장애는 정상 상황 — 상태만 남기고 다음 주기에 재시도한다.
      this.set({ kind: "error", message: err.message });
    });

    const check = () => {
      void u.checkForUpdates().catch((e: unknown) => {
        this.set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    };
    this.set({ kind: "idle" });
    check();
    const schedule =
      this.opts.schedule ??
      ((fn: () => void, ms: number) => {
        const t = setInterval(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return () => clearInterval(t);
      });
    this.stopSchedule = schedule(check, this.opts.intervalMs ?? SIX_HOURS_MS);
  }

  stop(): void {
    this.stopSchedule?.();
    this.stopSchedule = null;
  }

  // ready 상태에서만 유효 — 종료 후 새 버전으로 재실행. 호출 전에 러너 정리는 호출자(main) 책임.
  quitAndInstall(): void {
    if (this.current.kind !== "ready") {
      this.opts.log?.("업데이트가 준비되지 않아 quitAndInstall 을 무시합니다.");
      return;
    }
    this.opts.updater?.quitAndInstall(false, true);
  }

  private set(state: UpdaterState): void {
    this.current = state;
    this.emit(state);
  }

  private emit(state: UpdaterState): void {
    this.opts.onStatus?.(state);
  }
}
