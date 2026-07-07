// The barrel exposes UI+types only — api/releases is 'server-only' (uses the token), so server consumers (page/route) import it
// directly via the deep path (avoids polluting the client bundle).
export type { DesktopAsset, DesktopOs, DesktopRelease } from './api/releases'
export { DownloadPanel } from './ui/download-panel'
