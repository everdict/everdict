'use client'

import { NotificationBell } from '@/widgets/notification-bell'
import { WorkPanel } from '@/widgets/work-panel'

// 오른쪽 상단 떠 있는 컨트롤 클러스터 — 알림 벨(1번) + 작업 패널(2번). AppShell 이 한 번만 마운트.
// 데스크톱 셸(Electron)에선 타이틀바(--titlebar-h) 아래로 내려 겹치지 않는다. 주의: 이 컨테이너에는
// transform/filter/backdrop-filter 를 두지 말 것 — 안에 있는 WorkPanel 의 fixed 드로어의 컨테이닝
// 블록이 뷰포트가 아니게 되어 전체 높이 우측 드로어가 깨진다(그래서 유리효과 없이 불투명 pill 사용).
export function TopControls({ workspace }: { workspace: string }) {
  return (
    <div
      style={{ top: 'calc(var(--titlebar-h) + 0.375rem)' }}
      className="fixed right-4 z-40 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-raise"
    >
      <NotificationBell workspace={workspace} />
      <WorkPanel workspace={workspace} />
    </div>
  )
}
