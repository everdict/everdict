'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import { recordingResponseSchema, type Recording } from '@/entities/recording'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])

// 리플레이 플레이어 — 종료된 run의 봉인된 녹화를 한 번 불러온다. 프레임이 있으면 환경 화면을 스크럽/재생하고 그
// 시점까지의 로그를 함께 보여주며, 프레임 없이 로그만 있으면 로그 레인을 보여준다(발견성 — 녹화된 run은 무언가 뜬다).
// 라이브 화면(LiveScreen)의 <img> 렌더를 재사용하되 데이터 출처만 라이브 폴링 → 녹화 fetch로 바뀐다. 녹화 자체가
// 없으면 self-null. run 상세는 recordingRef가 있을 때만 이 위젯을 마운트한다.
export function ReplayPlayer({ runId, initialStatus }: { runId: string; initialStatus?: string }) {
  const t = useTranslations('replay')
  const [rec, setRec] = useState<Recording | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    // Only a settled run has a sealed recording.
    if (!initialStatus || !TERMINAL.has(initialStatus)) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/recording`)
        if (!res.ok) return
        const parsed = recordingResponseSchema.safeParse(await res.json())
        if (!cancelled && parsed.success && parsed.data.found) setRec(parsed.data.recording)
      } catch {
        // no recording — the widget self-nulls
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runId, initialStatus])

  const frames = useMemo(() => rec?.tracks.frames ?? [], [rec])
  const logs = useMemo(() => rec?.tracks.logs ?? [], [rec])
  const clamped = frames.length > 0 ? Math.min(index, frames.length - 1) : 0
  const current = frames[clamped]

  // Auto-advance one frame at a time; stop at the end.
  useEffect(() => {
    if (!playing || frames.length === 0) return
    const timer = setInterval(() => {
      setIndex((prev) => {
        if (prev >= frames.length - 1) {
          setPlaying(false)
          return prev
        }
        return prev + 1
      })
    }, 700)
    return () => clearInterval(timer)
  }, [playing, frames.length])

  // Still fetching (or the recording genuinely returned nothing). The run detail only mounts this when a
  // recording exists, so this is normally just the brief pre-fetch state.
  if (!rec) return null
  const shownLogs = current ? logs.filter((l) => l.t <= current.t) : logs
  // A truly empty recording (no frames, no logs) — nothing to show.
  if (!current && shownLogs.length === 0) return null
  const elapsedSec = current ? Math.max(0, current.t - rec.t0) / 1000 : 0

  return (
    <div className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <Card className="space-y-3 p-4">
        {current ? (
          <>
            <div className="overflow-hidden rounded-lg border border-border bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.ref}
                alt={t('frameAlt')}
                className="max-h-[28rem] w-full object-contain"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? t('pause') : t('play')}
              </Button>
              <input
                type="range"
                min={0}
                max={frames.length - 1}
                value={clamped}
                onChange={(e) => {
                  setPlaying(false)
                  setIndex(Number(e.target.value))
                }}
                className="h-1 flex-1 cursor-pointer accent-primary"
                aria-label={t('title')}
              />
              <span className="shrink-0 text-[11.5px] tabular-nums text-faint">
                {t('frameOf', { i: clamped + 1, n: frames.length })} · {elapsedSec.toFixed(1)}s
              </span>
            </div>
          </>
        ) : (
          // Logs-only recording (no frame series to scrub) — still shown so a recorded run is discoverable.
          <p className="text-[12px] text-muted-foreground">{t('logsOnly')}</p>
        )}
        {shownLogs.length > 0 && (
          <div className="max-h-40 overflow-auto rounded-md border border-border bg-elevated p-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            {shownLogs.map((l, i) => (
              <div key={`${l.t}-${i}`}>{l.text}</div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
