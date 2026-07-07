'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { DatasetCase } from '@/entities/dataset'
import { Button } from '@/shared/ui/button'

import { CaseCard } from './case-card'

const INITIAL = 5

// Case list — only 5 shown by default, the rest collapsed (the detail's main content is the activity history, so cases are secondary). Expand/collapse.
export function CaseList({ cases }: { cases: DatasetCase[] }) {
  const t = useTranslations('inspectDataset')
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? cases : cases.slice(0, INITIAL)
  const hidden = cases.length - INITIAL

  return (
    <div className="space-y-2">
      {shown.map((c) => (
        <CaseCard key={c.id} item={c} />
      ))}
      {hidden > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full gap-1.5"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3.5" /> {t('collapse')}
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" /> {t('showMore', { count: hidden })}
            </>
          )}
        </Button>
      )}
    </div>
  )
}
