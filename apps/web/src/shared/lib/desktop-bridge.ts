// Local mirror type of window.everdictDesktop injected by the desktop shell (apps/desktop preload).
// The web doesn't depend on @everdict/* packages (web rule), so this is manually kept in sync with apps/desktop/src/bridge.ts.

// The status of ONE paired runner on this device.
export interface DesktopRunnerStatus {
  paired: boolean
  runnerId?: string
  state: 'off' | 'idle' | 'running'
  activeJobs: number
  capabilities: string[]
}

// The aggregate status — every runner paired on this device (skill desktop D9). A device can register as several independent runners.
export interface DesktopRunnersStatus {
  runners: DesktopRunnerStatus[]
}

export interface DesktopAppInfo {
  version: string
  platform: string
  hostname: string
  capabilities: string[]
  // Logical CPU count — the soft-cap reference we warn against when pairing more runners than cores (D9). 0 on an older desktop.
  cpuCount: number
}

export interface EverdictDesktopBridge {
  appInfo(): Promise<DesktopAppInfo>
  // One-click pairing — additive (D9): each call registers one more runner. The token is passed down only via this call and stored in the OS keychain (no screen exposure / read-back).
  pairRunner(payload: { token: string; runnerId?: string; apiUrl?: string }): Promise<void>
  // Unpair a specific runner by id, or (omitted) every runner on this device.
  unpairRunner(runnerId?: string): Promise<void>
  runnerStatus(): Promise<DesktopRunnersStatus>
  // Subscribe to status — returns an unsubscribe function.
  onRunnerStatus(callback: (status: DesktopRunnersStatus) => void): () => void
}

// Present only when rendering inside the desktop shell — null in a regular browser.
export function getEverdictDesktop(): EverdictDesktopBridge | null {
  if (typeof window === 'undefined') return null
  return (window as Window & { everdictDesktop?: EverdictDesktopBridge }).everdictDesktop ?? null
}

// Normalize a bridge status payload into the aggregate list shape. An older desktop (pre-D9) returns a bare
// DesktopRunnerStatus object; wrap it so a newly-deployed web keeps working on a not-yet-updated desktop (version-skew tolerant).
export function normalizeRunnersStatus(raw: unknown): DesktopRunnersStatus {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.runners)) return { runners: o.runners as DesktopRunnerStatus[] }
    if ('paired' in o) return { runners: [o as unknown as DesktopRunnerStatus] }
  }
  return { runners: [] }
}

// Whether this device has at least one paired runner — the desktop then owns native OS notifications (the web bell yields).
export function desktopHasPairedRunner(status: DesktopRunnersStatus): boolean {
  return status.runners.some((r) => r.paired)
}
