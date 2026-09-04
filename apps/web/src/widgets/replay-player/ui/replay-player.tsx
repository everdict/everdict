'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { recordingResponseSchema, type Recording } from '@/entities/recording'
import { summarizeTraceEvent, traceKindColor, type TraceEvent } from '@/entities/run'
import { fmtBytes, fmtPct } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])

// HTTP status → text color for the network lane: 2xx/3xx ok (muted), 4xx/5xx error (destructive), pending (faint).
function netStatusColor(status?: number): string {
  if (status == null) return 'text-faint'
  if (status >= 400) return 'text-destructive'
  return 'text-muted-foreground'
}
// console level → dot color: error/warn stand out, everything else muted.
function consoleLevelColor(level: string): string {
  if (level === 'error') return 'bg-destructive'
  if (level === 'warning' || level === 'warn') return 'bg-amber-500'
  return 'bg-muted-foreground/50'
}

// One labeled stat of the runtime lane (CPU / memory / net I/O).
function RuntimeStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9.5px] font-[560] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 font-mono text-[12.5px] font-[560] tabular-nums">{value}</div>
    </div>
  )
}

// A minimal bar sparkline of CPU% over the runtime samples so far — normalized to the max in-window so the shape shows
// even at low absolute load. Purely decorative (aria-hidden); the numeric CPU stat carries the value.
function CpuSparkline({ samples }: { samples: { cpuPct?: number }[] }) {
  const values = samples.map((s) => s.cpuPct ?? 0)
  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  return (
    <div className="flex h-6 items-end gap-px" aria-hidden>
      {values.slice(-40).map((v, i) => (
        <span
          key={i}
          className="w-0.5 rounded-sm bg-primary/60"
          style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  )
}

// The replay player — it replays a run on one wall-clock (t0) timeline. **The agent trace is the SPINE**:
// whatever the harness (Claude Code, Codex, browser-use, a hand-built extension), there is always a trace, so trace events plus logs can be
// scrubbed in time sync even with no frames (= a coding agent replay). A run whose ENVIRONMENT left frames (browser/os-use) has the same
// scrubber overlay the screen at that moment. Frames, traces and logs all share one clock (the Date.now epoch, D1), so they align under a
// single playhead. docs/architecture/replay.md — Principle 1.
//
// **Live is a replay that has not finished.** While running, it polls the recording tail (peek) and the live trajectory onto the same
// timeline: the playhead pins to the end (LIVE) and follows each new moment, and scrubbing backwards releases the pin. When the run ends the
// polling stops and that same place simply becomes the replay — two STATES, not two views.
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
  const [liveTrace, setLiveTrace] = useState<TraceEvent[]>([])
  const [status, setStatus] = useState(initialStatus)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pinnedLive, setPinnedLive] = useState(true)
  const running = status !== undefined && !TERMINAL.has(status)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      let nextStatus: string | undefined
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/recording`)
        if (res.ok) {
          const parsed = recordingResponseSchema.safeParse(await res.json())
          if (cancelled) return
          if (parsed.success) {
            if (parsed.data.found) setRec(parsed.data.recording)
            nextStatus = parsed.data.status
          }
        }
      } catch {
        // no recording — trace-only replay still works
      }
      // While running, the live trajectory keeps the same beat — the pre-seal agent lane. After it ends, the server render hands over the sealed trace.
      const wasRunning = initialStatus !== undefined && !TERMINAL.has(nextStatus ?? initialStatus)
      if (wasRunning) {
        try {
          const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/trajectory/live`)
          if (res.ok) {
            const body = (await res.json()) as { status?: string; found: boolean; events?: TraceEvent[] }
            if (cancelled) return
            if (body.found && body.events) setLiveTrace(body.events)
            nextStatus = body.status ?? nextStatus
          }
        } catch {
          // transient — keep polling
        }
      }
      if (cancelled) return
      if (nextStatus) setStatus(nextStatus)
      const stillRunning = initialStatus !== undefined && !TERMINAL.has(nextStatus ?? initialStatus)
      if (stillRunning) timer = setTimeout(tick, 3000) // the run ending ends the polling (the last state IS the replay)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, initialStatus])

  // A sealed trace (the server render) is canonical when present; without one (= still running) the live trajectory fills the agent lane.
  const events = trace.length > 0 ? trace : liveTrace
  const frames = rec?.tracks.frames ?? []
  const logs = rec?.tracks.logs ?? []
  // ② environment plane (browser CDP) — how the world changed underneath the agent: the request track, console
  // messages, and navigation history over the wall clock. These are what a browser-use replay needs beyond the
  // agent's own decisions ("how did the page change", not just "what did the agent do"). docs/architecture/replay.md.
  const network = rec?.tracks.network ?? []
  const consoleMsgs = rec?.tracks.console ?? []
  const nav = rec?.tracks.nav ?? []
  // ③ runtime/system plane — the sandbox sampled over time (CPU/mem/net I/O + lifecycle). The only plane that shows
  // "did it OOM / thrash", invisible to both the agent trace and the environment DOM.
  const runtime = rec?.tracks.runtime ?? []
  // Repo environment plane — the in-run git-diff checkpoints folded onto the `custom` lane (name="repo-diff"). Each
  // entry is the cumulative working-tree-vs-HEAD diff at that moment, so scrubbing shows how the repo evolved.
  const repoDeltas = (rec?.tracks.custom ?? []).filter((c) => c.name === 'repo-diff' && c.text)

  // Scrub axis = wall-clock time. Steps are the meaningful "moments": frame ∪ trace ∪ repo-diff ∪ navigation ∪ runtime
  // sample times (each a distinct instant worth landing on). The dense/noisy lanes (network, console, logs) are shown
  // cumulatively up to the playhead but only SEED steps when nothing else does, so a run made only of them still scrubs.
  const stepSet = new Set<number>()
  for (const f of frames) stepSet.add(f.t)
  for (const e of events) stepSet.add(e.t)
  for (const d of repoDeltas) stepSet.add(d.t)
  for (const n of nav) stepSet.add(n.t)
  for (const s of runtime) stepSet.add(s.t)
  if (stepSet.size === 0) {
    for (const n of network) stepSet.add(n.t)
    for (const c of consoleMsgs) stepSet.add(c.t)
    for (const l of logs) stepSet.add(l.t)
  }
  const steps = Array.from(stepSet).sort((a, b) => a - b)

  // The LIVE pin — while running and pinned, the playhead is pulled to the end each time a new moment arrives.
  // Touching the scrubber or playback releases the pin, and the LIVE chip pins it again.
  const stepCount = steps.length
  useEffect(() => {
    if (running && pinnedLive && stepCount > 0) setIndex(stepCount - 1)
  }, [running, pinnedLive, stepCount])

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
  const shownTrace = events.filter((e) => e.t <= playheadT)
  const shownLogs = logs.filter((l) => l.t <= playheadT)
  // Environment lanes up to the playhead. Network/console are dense — cap the rendered tail (latest N) so a chatty page
  // doesn't blow up the DOM; the count reflects the full total so nothing is silently hidden.
  const shownNet = network.filter((n) => n.t <= playheadT)
  const shownConsole = consoleMsgs.filter((c) => c.t <= playheadT)
  const TAIL = 60
  // The current page URL = the latest navigation at or before the playhead (browser env).
  let currentUrl: string | undefined
  for (let i = nav.length - 1; i >= 0; i--) {
    if (nav[i].t <= playheadT) {
      currentUrl = nav[i].url
      break
    }
  }
  // The runtime sample at the playhead (latest at/before now) + the series so far (for the CPU sparkline).
  const runtimeSoFar = runtime.filter((s) => s.t <= playheadT)
  const runtimeNow = runtimeSoFar.at(-1)
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

        {/* Browser location (nav track) — the page URL at the playhead. Reads like an address bar over the frame. */}
        {currentUrl && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-elevated px-2 py-1">
            <span className="shrink-0 text-[9.5px] font-[560] uppercase tracking-wide text-faint">
              {t('navLane')}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
              {currentUrl}
            </span>
          </div>
        )}

        {/* Scrubber over the wall clock (frame times ∪ trace times). */}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setPinnedLive(false)
              setPlaying((p) => !p)
            }}
          >
            {playing ? t('pause') : t('play')}
          </Button>
          <input
            type="range"
            min={0}
            max={steps.length - 1}
            value={clamped}
            onChange={(e) => {
              setPlaying(false)
              setPinnedLive(false) // scrubbing backwards releases the live pin (the LIVE chip re-attaches)
              setIndex(Number(e.target.value))
            }}
            className="h-1 flex-1 cursor-pointer accent-primary"
            aria-label={t('title')}
          />
          <span className="shrink-0 text-[11.5px] tabular-nums text-faint">
            {t('stepOf', { i: clamped + 1, n: steps.length })} · {elapsedSec.toFixed(1)}s
          </span>
          {/* Only while running — pinned to the end the dot pulses, and while looking at the past it is pressed to return to the live edge. */}
          {running && (
            <button
              type="button"
              onClick={() => {
                setPlaying(false)
                setPinnedLive(true)
                setIndex(steps.length - 1)
              }}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-[600] tracking-wide',
                pinnedLive
                  ? 'border-red-500/40 text-red-500'
                  : 'border-border text-faint hover:text-foreground'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  pinnedLive ? 'animate-pulse bg-red-500' : 'bg-muted-foreground/50'
                )}
              />
              {t('live')}
            </button>
          )}
        </div>

        {/* Agent plane — the universal spine: the trace revealed up to the playhead, current event highlighted. */}
        {events.length > 0 && (
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

        {/* Network lane (browser env) — the requests that fired up to the playhead (latest first): method · url · status · ms. */}
        {shownNet.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
              {t('networkLane')} · {shownNet.length}
            </div>
            <div className="max-h-44 space-y-0.5 overflow-auto rounded-md border border-border bg-elevated p-2 font-mono text-[11px]">
              {shownNet
                .slice(-TAIL)
                .reverse()
                .map((n, i) => (
                  <div key={`${n.t}-${i}`} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 font-[560] text-faint">{n.method}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{n.url}</span>
                    <span
                      className={cn('w-7 shrink-0 text-right tabular-nums', netStatusColor(n.status))}
                      title={n.status == null ? t('netPending') : undefined}
                    >
                      {n.status ?? '·'}
                    </span>
                    <span className="w-12 shrink-0 text-right tabular-nums text-faint">
                      {n.ms != null ? `${Math.round(n.ms)}ms` : ''}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Console lane (browser env) — console messages up to the playhead; error/warn colored. Drops the old constant []. */}
        {shownConsole.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
              {t('consoleLane')} · {shownConsole.length}
            </div>
            <div className="max-h-40 space-y-0.5 overflow-auto rounded-md border border-border bg-elevated p-2 font-mono text-[11px]">
              {shownConsole.slice(-TAIL).map((c, i) => (
                <div key={`${c.t}-${i}`} className="flex items-start gap-2">
                  <span
                    className={cn('mt-1 size-1.5 shrink-0 rounded-full', consoleLevelColor(c.level))}
                  />
                  <span className="min-w-0 whitespace-pre-wrap break-all text-muted-foreground">
                    {c.text}
                  </span>
                </div>
              ))}
            </div>
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

        {/* Runtime/system plane — the sandbox at the playhead (CPU/mem/net I/O + a CPU sparkline over the samples so far).
            The only lane that shows "did it OOM / thrash", invisible to the agent trace and the environment DOM. */}
        {runtimeNow && (
          <div className="space-y-1.5">
            <div className="text-[10.5px] font-[560] uppercase tracking-wide text-faint">
              {t('runtimeLane')}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-elevated p-2.5">
              <RuntimeStat
                label={t('cpuLabel')}
                value={runtimeNow.cpuPct != null ? fmtPct(runtimeNow.cpuPct / 100) : '–'}
              />
              <RuntimeStat label={t('memLabel')} value={fmtBytes(runtimeNow.memBytes)} />
              <RuntimeStat
                label={t('netLabel')}
                value={`↓${fmtBytes(runtimeNow.rxBytes)} · ↑${fmtBytes(runtimeNow.txBytes)}`}
              />
              <CpuSparkline samples={runtimeSoFar} />
              {runtimeNow.event && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-[560] text-muted-foreground">
                  {runtimeNow.event}
                </span>
              )}
            </div>
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
