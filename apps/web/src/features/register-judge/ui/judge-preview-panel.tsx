'use client'

import { useState, useTransition } from 'react'
import { Eye, Loader2, Play } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { previewJudgeAction, tryJudgeAction, type TryJudgeResult } from '../api/register-judge'

// Live judge preview — renders the EXACT judging prompt + per-placeholder evidence coverage for the current draft
// judge against a pasted trace, with NO model call. Lets a user verify what the judge will see before registering.
// getSpec() reads the current form spec on demand, so the panel reflects the latest edits without prop threading.
export function JudgePreviewPanel({ getSpec }: { getSpec: () => unknown }) {
  const t = useTranslations('judgePreview')
  const [trace, setTrace] = useState('')
  const [task, setTask] = useState('')
  const [expected, setExpected] = useState('')
  const [result, setResult] = useState<TryJudgeResult | undefined>()
  const [parseError, setParseError] = useState<string | undefined>()
  const [busy, start] = useTransition()

  // Parse the pasted trace once; empty is a valid empty trace. Returns undefined on a JSON error (and sets the message).
  function parseTrace(): unknown | undefined {
    setParseError(undefined)
    setResult(undefined)
    if (!trace.trim()) return []
    try {
      return JSON.parse(trace)
    } catch {
      setParseError(t('invalidTrace'))
      return undefined
    }
  }

  function meta() {
    return {
      ...(task.trim() ? { task: task.trim() } : {}),
      ...(expected.trim() ? { expected: expected.trim() } : {}),
    }
  }

  function onPreview() {
    const parsed = parseTrace()
    if (parsed === undefined) return
    start(async () => setResult(await previewJudgeAction(getSpec(), parsed, meta())))
  }

  function onTry() {
    const parsed = parseTrace()
    if (parsed === undefined) return
    start(async () => setResult(await tryJudgeAction(getSpec(), parsed, meta())))
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{t('heading')}</h3>
        <p className="text-[12px] text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="preview-trace">{t('traceLabel')}</Label>
        <Textarea
          id="preview-trace"
          value={trace}
          onChange={(e) => setTrace(e.target.value)}
          placeholder={t('tracePlaceholder')}
          rows={5}
          className="font-mono text-[12px]"
        />
        <p className="text-[12px] text-muted-foreground">{t('traceHint')}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="preview-task">{t('taskLabel')}</Label>
          <Input id="preview-task" value={task} onChange={(e) => setTask(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="preview-expected">{t('expectedLabel')}</Label>
          <Input id="preview-expected" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onPreview} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
          {t('previewButton')}
        </Button>
        <Button variant="ghost" onClick={onTry} disabled={busy} className="gap-1.5">
          <Play className="size-4" />
          {t('tryButton')}
        </Button>
        <span className="text-[12px] text-muted-foreground">{t('tryHint')}</span>
      </div>

      {parseError ? <Callout tone="danger">{parseError}</Callout> : null}
      {result && !result.ok ? <Callout tone="danger">{result.error ?? t('failed')}</Callout> : null}

      {result?.ok ? (
        <div className="space-y-3">
          {result.scores ? (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-muted-foreground">{t('scores')}</p>
              {result.scores.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t('noScores')}</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {result.scores.map((s) => (
                    <div
                      key={s.metric}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-[12px]',
                        s.pass === true
                          ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/8'
                          : s.pass === false
                            ? 'border-destructive/30 bg-destructive/8'
                            : 'border-border bg-muted/40',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono">{s.metric}</span>
                        <span className="tabular-nums">
                          {s.value.toFixed(2)}
                          {s.pass === true ? ' · ✓' : s.pass === false ? ' · ✗' : ''}
                        </span>
                      </div>
                      {typeof s.detail === 'string' && s.detail ? (
                        <p className="mt-0.5 text-muted-foreground">{s.detail}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {result.warnings && result.warnings.length > 0 ? (
            <Callout tone="warning">
              <ul className="list-disc space-y-0.5 pl-4">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          {result.evidence ? (
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">{t('coverage')}</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(result.evidence).map(([key, c]) => (
                  <span
                    key={key}
                    className={cn(
                      'rounded-md border px-2 py-0.5 text-[12px]',
                      c.present
                        ? c.truncated
                          ? 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/8 text-[var(--color-warning)]'
                          : 'border-primary/25 bg-primary/6 text-foreground'
                        : 'border-border bg-muted/50 text-muted-foreground line-through',
                    )}
                    title={c.present ? t('chars', { n: c.chars }) : t('absent')}
                  >
                    {key}
                    {c.truncated ? ` · ${t('truncated')}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {result.requirements ? (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-muted-foreground">{t('requirements')}</p>
              <div className="flex flex-wrap gap-1.5">
                {result.requirements.satisfied.map((r, i) => (
                  <span
                    key={`ok-${i}-${r.kind}`}
                    className="rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success)]/8 px-2 py-0.5 text-[12px] text-[var(--color-success)]"
                  >
                    ✓ {r.kind}
                    {r.name ? `:${r.name}` : r.role ? `:${r.role}` : ''}
                  </span>
                ))}
                {result.requirements.missing.map((r, i) => (
                  <span
                    key={`no-${i}-${r.kind}`}
                    className="rounded-md border border-destructive/30 bg-destructive/8 px-2 py-0.5 text-[12px] text-destructive"
                  >
                    ✗ {r.kind}
                    {r.name ? `:${r.name}` : r.role ? `:${r.role}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {result.prompt ? (
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">{t('renderedPrompt')}</p>
              <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">
                {result.prompt}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
