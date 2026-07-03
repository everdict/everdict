// 배럴은 UI+타입만 — api/releases 는 'server-only'(토큰 사용)라 서버 소비자(page/route)가 깊은 경로로
// 직접 import 한다(클라이언트 번들 오염 방지).
export type { DesktopAsset, DesktopOs, DesktopRelease } from './api/releases'
export { DownloadPanel } from './ui/download-panel'
