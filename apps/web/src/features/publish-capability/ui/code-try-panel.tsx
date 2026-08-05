'use client'

import { useState } from 'react'
import { CheckCircle2, FlaskConical, Play, ShieldAlert, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { CapabilitySpec, CodeToolTryResult } from '@/entities/capability'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Label, Textarea } from '@/shared/ui/input'

import { tryCodeToolAction } from '../api/wizard-tools'

// code 도구 검증 패널 — 코드만 보고 채택/발행하지 않는다: check(구문, 파스만) + run(예제 입력으로 실제 1회 실행,
// 에이전트와 동일 실행계약·샌드박스 게이트). 위저드(draft spec 빌더)와 스토어 상세(발행본 ref) 양쪽이 재사용한다.
export type CodeTryTargetBuilder = () =>
  | { name?: string; spec: CapabilitySpec }
  | { ref: { source: string; id: string; version: string } }
  | { error: string }

export function CodeTryPanel({
  buildTarget,
  initialInput,
  showCheck,
}: {
  buildTarget: CodeTryTargetBuilder
  initialInput?: string // 예제 입력 JSON 프리필(보통 첫 예제)
  showCheck: boolean // 위저드=true(발행 전 구문검사), 스토어 상세=false(실행만)
}) {
  const t = useTranslations('capabilityStore')
  const [input, setInput] = useState(initialInput ?? '{}')
  const [result, setResult] = useState<CodeToolTryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const fire = (mode: 'check' | 'run') => {
    setError(null)
    setResult(null)
    const target = buildTarget()
    if ('error' in target) {
      setError(target.error)
      return
    }
    let parsedInput: Record<string, unknown> = {}
    if (mode === 'run') {
      try {
        const raw = input.trim().length > 0 ? (JSON.parse(input) as unknown) : {}
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error('object required')
        parsedInput = raw as Record<string, unknown>
      } catch (e) {
        setError(t('tryInvalidJson', { error: e instanceof Error ? e.message : String(e) }))
        return
      }
    }
    void (async () => {
      setPending(true)
      try {
        const r = await tryCodeToolAction({
          mode,
          ...target,
          ...(mode === 'run' ? { input: parsedInput } : {}),
        })
        if (r.ok && r.result) setResult(r.result)
        else setError(r.error ?? t('tryError'))
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-medium">
        <FlaskConical className="size-4 text-primary" />
        {t('tryTitle')}
      </div>
      <div className="space-y-1">
        <Label htmlFor="code-try-input">{t('tryInputLabel')}</Label>
        <Textarea
          id="code-try-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          className="font-mono text-[12px]"
          placeholder='{"query": "…"}'
        />
      </div>
      <div className="flex items-center gap-2">
        {showCheck && (
          <Button variant="outline" size="sm" onClick={() => fire('check')} disabled={pending}>
            <CheckCircle2 />
            {pending ? t('tryRunning') : t('tryCheck')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => fire('run')} disabled={pending}>
          <Play />
          {pending ? t('tryRunning') : t('tryRun')}
        </Button>
      </div>
      {error !== null && (
        <p className="flex items-start gap-1.5 text-[12.5px] text-destructive">
          <XCircle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}
      {result !== null && (
        <div className="space-y-1.5">
          <p
            className={cn(
              'flex items-center gap-1.5 text-[12.5px] font-medium',
              result.ok ? 'text-success' : 'text-destructive'
            )}
          >
            {result.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
            {result.mode === 'check'
              ? t(result.ok ? 'tryCheckPassed' : 'tryCheckFailed')
              : t(result.ok ? 'tryRunPassed' : 'tryRunFailed', { ms: result.durationMs })}
          </p>
          {result.missingSecrets.length > 0 && (
            <p className="flex items-start gap-1.5 text-[12px] text-warning">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              {t('tryMissingSecrets', { names: result.missingSecrets.join(', ') })}
            </p>
          )}
          {result.content.length > 0 && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-secondary/50 p-2 font-mono text-[11.5px] leading-relaxed">
              {result.content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
