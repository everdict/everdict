'use client'

import { useState } from 'react'
import { Braces, ChevronDown } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { HarnessInstanceSpec, HarnessSpec, HarnessTemplateSpec } from '@/entities/harness'
import { cn } from '@/shared/lib/utils'
import { JsonView } from '@/shared/ui/json-view'

import { ConfigPanel } from './config-panel'

// 원본 구성(템플릿 참조 + pins + overrides) + 최종 스펙 JSON — 기본은 접혀 있고, 필요할 때만 펼친다.
// 주 화면은 깔끔한 값 리스트, "원본/JSON" 은 새 버전 편집·디버깅용 부가 정보라 여기 접어둔다.
export function RawConfigDisclosure({
  config,
  spec,
}: {
  config?: { instance: HarnessInstanceSpec; template: HarnessTemplateSpec }
  spec: HarnessSpec
}) {
  const t = useTranslations('inspectHarness')
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-secondary/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
      >
        <span className="inline-flex items-center gap-2 text-[13px] font-[560] text-foreground">
          <Braces className="size-3.5 text-muted-foreground" />
          {t('rawConfigTitle')}
          <span className="text-[12px] font-normal text-muted-foreground">
            {t('rawConfigHint')}
          </span>
        </span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="space-y-6 border-t border-border px-4 py-4">
          {config && <ConfigPanel instance={config.instance} template={config.template} />}
          <JsonView value={spec} />
        </div>
      )}
    </div>
  )
}
