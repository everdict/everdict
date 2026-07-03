import { z } from "zod";

// window.assayDesktop 브리지의 메인 프로세스 쪽 절반 — 채널 상수·페이로드 검증·origin 가드·핸들러 등록.
// 채널 문자열은 preload.cts 와 수동 동기화(preload 는 CJS 라 이 모듈을 import 하지 못한다).
// 스킬 desktop 불변식 3(메서드 4개가 전부)·4(권한 경계는 IPC origin 검사).
export const BRIDGE_CHANNELS = {
  appInfo: "assay:app-info",
  pair: "assay:pair-runner",
  unpair: "assay:unpair-runner",
  status: "assay:runner-status",
  statusEvent: "assay:runner-status-event",
} as const;

// 웹(브리지 호출자)이 넘기는 페어링 페이로드 — 경계 Zod 검증. 토큰은 이 경로로 내려와 keychain 에만 저장된다.
export const PairPayloadSchema = z.object({
  token: z.string().startsWith("rnr_"),
  runnerId: z.string().min(1).optional(),
  apiUrl: z.string().url().optional(),
});
export type PairPayload = z.infer<typeof PairPayloadSchema>;

// 웹에 보여주는 러너 상태 — apps/web `shared/lib/desktop-bridge.ts` 미러와 수동 동기화(웹은 @assay/* 미의존).
export interface DesktopRunnerStatus {
  paired: boolean;
  runnerId?: string;
  state: "off" | "idle" | "running";
  activeJobs: number;
  capabilities: string[];
}

export interface DesktopAppInfo {
  version: string;
  platform: string;
  hostname: string;
  capabilities: string[];
}

// IPC sender 프레임 origin 검증 — 브리지 권한의 실제 경계(네비게이션 정책이 아니라 여기서 지킨다).
export function senderAllowed(frameUrl: string | undefined, webOrigin: string): boolean {
  if (!frameUrl) return false;
  try {
    return new URL(frameUrl).origin === webOrigin;
  } catch {
    return false;
  }
}

// electron ipcMain 의 최소 표면 — 테스트는 가짜 주입(electron 값 import 없음).
interface InvokeEventLike {
  senderFrame: { url: string } | null;
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEventLike, payload: unknown) => unknown): void;
}

export interface BridgeDeps {
  webOrigin: string;
  appInfo(): Promise<DesktopAppInfo>;
  pair(payload: PairPayload): Promise<void>;
  unpair(): Promise<void>;
  status(): DesktopRunnerStatus;
}

export function registerBridge(ipc: IpcMainLike, deps: BridgeDeps): void {
  const guarded =
    (handler: (payload: unknown) => unknown) =>
    (event: InvokeEventLike, payload: unknown): unknown => {
      if (!senderAllowed(event.senderFrame?.url, deps.webOrigin))
        throw new Error("허용되지 않은 origin 의 브리지 호출입니다.");
      return handler(payload);
    };
  ipc.handle(
    BRIDGE_CHANNELS.appInfo,
    guarded(() => deps.appInfo()),
  );
  ipc.handle(
    BRIDGE_CHANNELS.pair,
    guarded((payload) => deps.pair(PairPayloadSchema.parse(payload))),
  );
  ipc.handle(
    BRIDGE_CHANNELS.unpair,
    guarded(() => deps.unpair()),
  );
  ipc.handle(
    BRIDGE_CHANNELS.status,
    guarded(() => deps.status()),
  );
}
