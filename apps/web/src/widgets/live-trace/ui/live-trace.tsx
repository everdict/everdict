'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import { asSingleSegment, TrajectoryView } from '@/features/browse-traces'
import { traceEventSchema, type TraceEvent } from '@/entities/trace'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 3000

// 라이브 트레이스 패널 (observability ⑨) — 실행 중인 run의 궤적이 쌓이는 대로 3초마다 폴링해 그린다:
// 디스패치 배치 마크(수락→대기→시작) + 러너 푸시 배치 + 매니지드 잡의 이벤트 센티널. 스냅숏 의미론이라
// 매 폴이 지금까지의 전량을 돌려주고, 위젯은 통째로 교체한다(diff 없음 — LiveLogs 와 같은 선택).
// 아직 아무 이벤트도 없으면 통째로 숨긴다(빈 섹션 금지); run 이 종료되면 폴링을 멈추고 마지막 읽기를
// 남긴다 — 봉인된 증거 섹션이 권위 표면이고, 이 패널은 그 미리보기다.
export function LiveTrace({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('liveTraceView')
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [status, setStatus] = useState(initialStatus)

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/trajectory/live`)
        if (res.ok) {
          const body = (await res.json()) as { status: string; found: boolean; events: unknown[] }
          if (stopped) return
          setStatus(body.status)
          // 페이지의 toEvidence 와 같은 이벤트 단위 엄격 렌즈: 이 빌드가 모르는 kind 는 그 이벤트만
          // 빠지고 나머지는 그대로 그려진다 — 서버가 어휘를 늘려도 라이브 뷰가 통째로 비지 않는다.
          const evidence: TraceEvent[] = []
          for (const event of body.events) {
            const parsed = traceEventSchema.safeParse(event)
            if (parsed.success) evidence.push(parsed.data)
          }
          setEvents(evidence)
          if (TERMINAL.has(body.status)) return // run 종료 — 마지막 읽기를 남기고 폴링 중단
        }
      } catch {
        // 일시 오류 — 폴링 지속
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, initialStatus])

  // 봉인된 증거 뷰와 같은 읽기 표면(TrajectoryView) — 라이브는 실행 자신의 단일 세그먼트다.
  const segments = useMemo(() => asSingleSegment(events, 'run'), [events])

  // 아직 아무것도 도착하지 않은 run — 빈 박스 대신 통째로 숨긴다.
  if (events.length === 0) return null

  const live = !TERMINAL.has(status)
  return (
    <div className="space-y-2.5">
      <SectionHeader
        title={t('title')}
        action={
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-faint">
            {live && (
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--color-success)] opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-[var(--color-success)]" />
              </span>
            )}
            {live ? t('streaming') : t('finished')}
          </span>
        }
      />
      <Card className="h-[48vh] min-h-[320px] p-4">
        <TrajectoryView segments={segments} />
      </Card>
    </div>
  )
}
