'use client'

import { CheckCircle2, FileOutput, TimerOff, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FileExecutionResultView } from '@/entities/workspace-file'
import { fmtBytes } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// What a run produced, rendered the way a terminal would: the streams as they came, the exit code as a fact
// rather than an error banner. A script that exits non-zero has RUN — the person reading it wants the traceback,
// not a toast saying something went wrong.
export function ExecutionOutput({
  result,
  onOpenOutput,
}: {
  result: FileExecutionResultView
  onOpenOutput?: (path: string) => void // produced files are real files — clicking one opens it in the viewer
}) {
  const t = useTranslations('files')
  const failed = result.exitCode !== 0
  const streams = [result.stdout, result.stderr].filter((s) => s !== '').join('\n')

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[11.5px]">
        <span
          className={cn(
            'inline-flex items-center gap-1 font-[510]',
            failed ? 'text-destructive' : 'text-success'
          )}
        >
          {result.timedOut ? (
            <TimerOff className="size-3.5" />
          ) : failed ? (
            <XCircle className="size-3.5" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )}
          {result.timedOut
            ? t('runTimedOut')
            : failed
              ? t('runExit', { code: result.exitCode })
              : t('runOk')}
        </span>
        <span className="text-muted-foreground">{t('runDuration', { ms: result.durationMs })}</span>
        <span className="truncate font-mono text-muted-foreground">{result.image}</span>
      </div>

      <pre className="max-h-[320px] overflow-auto px-3 pb-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
        {streams === '' ? (
          <span className="text-muted-foreground">{t('runNoOutput')}</span>
        ) : (
          streams
        )}
        {result.truncated && (
          <span className="text-muted-foreground">{`\n${t('runTruncated')}`}</span>
        )}
      </pre>

      {result.outputs.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <p className="mb-1.5 text-[11.5px] text-muted-foreground">{t('runOutputs')}</p>
          <ul className="flex flex-wrap gap-1.5">
            {result.outputs.map((output) => (
              <li key={output.path}>
                <button
                  type="button"
                  disabled={output.skipped === true || onOpenOutput === undefined}
                  onClick={() => onOpenOutput?.(output.path)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11.5px]',
                    output.skipped === true
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground hover:border-primary'
                  )}
                  title={output.skipped === true ? t('runOutputSkipped') : output.path}
                >
                  <FileOutput className="size-3" />
                  {output.name}
                  <span className="text-muted-foreground">{fmtBytes(output.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
