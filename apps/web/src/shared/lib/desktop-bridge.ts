// 데스크톱 셸(apps/desktop preload)이 주입하는 window.assayDesktop 의 로컬 미러 타입.
// 웹은 @assay/* 패키지를 의존하지 않으므로(웹 룰) apps/desktop/src/bridge.ts 와 수동 동기화한다.
export interface DesktopRunnerStatus {
  paired: boolean
  runnerId?: string
  state: 'off' | 'idle' | 'running'
  activeJobs: number
  capabilities: string[]
}

export interface DesktopAppInfo {
  version: string
  platform: string
  hostname: string
  capabilities: string[]
}

export interface AssayDesktopBridge {
  appInfo(): Promise<DesktopAppInfo>
  // 원클릭 페어링 — 토큰은 이 호출로만 내려가 OS keychain 에 저장된다(화면 노출·되읽기 없음).
  pairRunner(payload: { token: string; runnerId?: string; apiUrl?: string }): Promise<void>
  unpairRunner(): Promise<void>
  runnerStatus(): Promise<DesktopRunnerStatus>
  // 상태 구독 — 해지 함수를 돌려준다.
  onRunnerStatus(callback: (status: DesktopRunnerStatus) => void): () => void
}

// 데스크톱 셸 안에서 렌더링 중일 때만 존재 — 일반 브라우저에선 null.
export function getAssayDesktop(): AssayDesktopBridge | null {
  if (typeof window === 'undefined') return null
  return (window as Window & { assayDesktop?: AssayDesktopBridge }).assayDesktop ?? null
}
