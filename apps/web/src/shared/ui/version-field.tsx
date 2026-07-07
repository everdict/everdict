'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { bumpSemver, maxSemver, type BumpKind } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Label } from '@/shared/ui/input'

const KINDS: BumpKind[] = ['patch', 'minor', 'major']

// 시스템 관리 버저닝: 같은 id 에 기존 버전이 있으면 patch/minor/major 범프를 고른다(raw 입력 X — 항상 최신 위로).
// 처음 등록이면 1.0.0. value 는 시스템이 계산해 부모로 흘려보낸다.
export function VersionField({
  existing,
  value,
  onChange,
}: {
  existing: string[]
  value: string
  onChange: (v: string) => void
}) {
  const t = useTranslations('ui')
  const latest = maxSemver(existing)
  const [kind, setKind] = useState<BumpKind>('patch')

  // latest(=id 의 기존 버전) 또는 kind 가 바뀌면 다음 버전을 시스템이 계산해 반영.
  // onChange 는 의존성에서 제외(부모 재렌더마다 신원이 바뀌어 무한 루프가 됨).
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    onChangeRef.current(latest ? bumpSemver(latest, kind) : '1.0.0')
  }, [latest, kind])

  return (
    <div className="space-y-1.5">
      <Label>
        version <span className="font-normal text-faint">· {t('versionSystemManaged')}</span>
      </Label>
      {latest ? (
        <div className="space-y-1.5">
          <div className="inline-flex rounded-lg border bg-secondary/40 p-0.5">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[13px] transition-colors',
                  kind === k
                    ? 'bg-card font-[510] text-foreground shadow-raise'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {k}{' '}
                <span className="font-mono text-[11px] opacity-60">{bumpSemver(latest, k)}</span>
              </button>
            ))}
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {t.rich('versionBump', {
              existing: existing.join(', '),
              latest,
              value,
              code: (chunks) => (
                <code className="rounded bg-secondary px-1 font-mono text-[11px]">{chunks}</code>
              ),
              codeNew: (chunks) => (
                <code className="rounded bg-secondary px-1 font-mono text-[11px] text-foreground">
                  {chunks}
                </code>
              ),
            })}
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2 py-1">
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-foreground">
            1.0.0
          </code>
          <span className="text-[12px] text-muted-foreground">{t('versionFirstHint')}</span>
        </div>
      )}
    </div>
  )
}
