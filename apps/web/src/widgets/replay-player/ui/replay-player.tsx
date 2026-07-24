'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { recordingResponseSchema, type Recording } from '@/entities/recording'
import { summarizeTraceEvent, traceKindColor, type TraceEvent } from '@/entities/run'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])

// 리플레이 플레이어 — 종료된 run을 하나의 벽시계(t0) 타임라인에서 재생한다. **agent trace가 척추**다:
// 어떤 하네스(Claude Code·Codex·browser-use·직접 만든 확장)든 trace는 항상 있으므로, 프레임이 없어도
// trace 이벤트 + 로그를 시점 동기로 스크럽할 수 있다(= 코딩 에이전트 replay). 환경이 프레임을 남긴 run
// (browser/os-use)은 같은 스크러버가 그 시점의 화면까지 오버레이한다. 프레임·트레이스·로그는 모두 같은
// 클럭(Date.now epoch, D1)을 공유하므로 하나의 재생 헤드로 정렬된다. docs/architecture/replay.md — Principle 1.
export function ReplayPlayer({
  runId,
  initialStatus,
  trace,
}: {
  runId: string
  initialStatus?: string
  trace: TraceEvent[]
}) {
  const t = useTranslations('replay')
  const [rec, setRec] = useState<Recording | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    // Only a settled run has a sealed recording; the agent trace (props) replays regardless.
    if (!initialStatus || !TERMINAL.has(initialStatus)) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/recording`)
        if (!res.ok) return
        const parsed = recordingResponseSchema.safeParse(await res.json())
        if (!cancelled && parsed.success && parsed.data.found) setRec(parsed.data.recording)
      } catch {
        // no recording — trace-only replay still works
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runId, initialStatus])

  const frames = rec?.tracks.frames ?? []
  const logs = rec?.tracks.logs ?? []
  // Repo environment plane — the in-run git-diff checkpoints folded onto the `custom` lane (name="repo-diff"). Each
  // entry is the cumulative working-tree-vs-HEAD diff at that moment, so scrubbing shows how the repo evolved.
  const repoDeltas = (rec?.tracks.custom ?? []).filter((c) => c.name === 'repo-diff' && c.text)

  // Scrub axis = wall-clock time. Steps are the meaningful "moments": frame times ∪ trace-event times ∪ repo-diff
  // times. Logs alone (dense/noisy) only seed steps when nothing else exists, so a log-only recording still scrubs.
  const stepSet = new Set<number>()
  for (const f of frames) stepSet.add(f.t)
  for (const e of trace) stepSet.add(e.t)
  for (const d of repoDeltas) stepSet.add(d.t)
  if (stepSet.size === 0) for (const l of logs) stepSet.add(l.t)
  const steps = Array.from(stepSet).sort((a, b) => a - b)

  // Auto-advance one moment at a time; stop at the end.
  useEffect(() => {
    if (!playing || steps.length === 0) return
    const timer = setInterval(() => {
      setIndex((prev) => {
        if (prev >= steps.length - 1) {
          setPlaying(false)
          return prev
        }
        return prev + 1
      })
    }, 700)
    return () => clearInterval(timer)
  }, [playing, steps.length])

  // Nothing to replay at all (no trace, no recording) — self-null. The run detail only mounts this for a
  // terminal run with a trace or a recordingRef, so this is normally just the brief pre-fetch state.
  if (steps.length === 0) return null

  const clamped = Math.min(index, steps.length - 1)
  const playheadT = steps[clamped]

  // The environment frame at the playhead — the last frame captured at or before now (absent for trace-only runs).
  let frame: (typeof frames)[number] | undefined
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].t <= playheadT) {
      frame = frames[i]
      break
    }
  }
  // The repo state (cumulative diff) at the playhead — the latest checkpoint captured at or before now.
  let repo: (typeof repoDeltas)[number] | undefined
  for (let i = repoDeltas.length - 1; i >= 0; i--) {
    if (repoDeltas[i].t <= playheadT) {
      repo = repoDeltas[i]
      break
    }
  }
  const shownTrace = trace.filter((e) => e.t <= playheadT)
  const shownLogs = logs.filter((l) => l.t <= playheadT)
  const t0 = steps[0]
  const elapsedSec = Math.max(0, playheadT - t0) / 1000

  return (
    <div className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <Card className="space-y-3 p-4">
        {/* Environment frame (browser/os-use) at the playhead — omitted entirely for a trace-only run. */}
        {frame && (
          <div className="overflow-hidden rounded-lg border border-border bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={frame.ref}
              alt={t('frameAlt')}
              className="max-h-[28rem] w-full object-contain"
            />
          </div>
        )}

        {/* Scrubber over the wall clock (frame times ∪ trace times). */}
        <div className="flex items-center gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => setPlaying((p) => !p)}>
            {playing ? t('pause') : t('play')}
          </Button>
          <input
            type="range"
            min={0}
            max={steps.length - 1}
            value={clamped}
            onChange={(e) => {
              setPlaying(false)
              setIndex(Number(e.target.value))
            }}
            className="h-1 flex-1 cursor-pointer accent-primary"
            aria-label={t('title')}
          />
          <span className="shrink-0 text-[11.5px] tabular-nums text-faint">
            {t('stepOf', { i: clamped + 1, n: steps.length })} · {elapsedSec.toFixed(1)}s
          </span>
        </div>

        {/* Agent plane — the universal spine: the trace revealed up to the playhead, current event highlighted. */}
        {trace.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
              {t('agentPlane')}
            </div>
            <ol className="max-h-56 space-y-1 overflow-auto">
              {shownTrace.map((e, i) => {
                const current = i === shownTrace.length - 1
                return (
                  <li
                    key={i}
                    className={cn(
                      'flex items-start gap-2 rounded-md px-2 py-1 text-[11.5px]',
                      current && 'bg-muted'
                    )}
                  >
                    <span
                      className={cn('mt-1 size-2 shrink-0 rounded-full', traceKindColor(e.kind))}
                    />
                    <code className="shrink-0 font-mono text-[10.5px] font-[510] text-faint">
                      {e.kind}
                    </code>
                    <span className="min-w-0 break-all text-muted-foreground">
                      {summarizeTraceEvent(e)}
                    </span>
                  </li>
                )
              })}
            </ol>
          </div>
        )}

        {/* Repo environment plane — the cumulative git-diff at the playhead (a coding harness's "how the repo changed"). */}
        {repo?.text && (
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
              {t('repoLane')}
            </div>
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-elevated p-2 font-mono text-[11px] leading-relaxed">
              {repo.text.split('\n').map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    line.startsWith('@@') && 'text-primary',
                    line.startsWith('+') && !line.startsWith('+++') && 'text-[var(--color-success)]',
                    line.startsWith('-') && !line.startsWith('---') && 'text-destructive',
                    (line.startsWith('diff ') ||
                      line.startsWith('index ') ||
                      line.startsWith('+++') ||
                      line.startsWith('---')) &&
                      'text-faint'
                  )}
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        )}

        {/* Environment/job log lane, synced to the playhead. */}
        {shownLogs.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
              {t('logLane')}
            </div>
            <div className="max-h-40 overflow-auto rounded-md border border-border bg-elevated p-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
              {shownLogs.map((l, i) => (
                <div key={`${l.t}-${i}`}>{l.text}</div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
