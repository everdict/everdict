// Local mirror type of window.everdictDesktop injected by the desktop shell (apps/desktop preload).
// The web doesn't depend on @everdict/* packages (web rule), so this is manually kept in sync with apps/desktop/src/bridge.ts.
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

export interface EverdictDesktopBridge {
  appInfo(): Promise<DesktopAppInfo>
  // One-click pairing — the token is passed down only via this call and stored in the OS keychain (no screen exposure / read-back).
  pairRunner(payload: { token: string; runnerId?: string; apiUrl?: string }): Promise<void>
  unpairRunner(): Promise<void>
  runnerStatus(): Promise<DesktopRunnerStatus>
  // Subscribe to status — returns an unsubscribe function.
  onRunnerStatus(callback: (status: DesktopRunnerStatus) => void): () => void
}

// Present only when rendering inside the desktop shell — null in a regular browser.
export function getEverdictDesktop(): EverdictDesktopBridge | null {
  if (typeof window === 'undefined') return null
  return (window as Window & { everdictDesktop?: EverdictDesktopBridge }).everdictDesktop ?? null
}
