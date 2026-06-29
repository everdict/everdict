'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// 비종단 상태(queued/running)일 때 주기적으로 서버 컴포넌트를 재실행(router.refresh)해 "진행 과정"을 라이브로 갱신한다.
// router.refresh 는 서버에서 다시 fetch 하므로 브라우저→컨트롤플레인 직접 호출 금지 규칙을 지킨다. 렌더 출력은 없다.
export function AutoRefresh({
  enabled,
  intervalMs = 2500,
}: {
  enabled: boolean
  intervalMs?: number
}) {
  const router = useRouter()
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(t)
  }, [enabled, intervalMs, router])
  return null
}
