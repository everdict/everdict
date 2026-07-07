'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import {
  InstanceForm,
  TemplateForm,
  type InstanceState,
  type ScopedSecretNames,
  type TemplateState,
} from '@/features/register-harness'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'

type Tab = 'instance' | 'template'

// New harness version — two axes: instance (re-pin pins → new instance version) | template (structural change → new template semver).
// After registering a new template version, redirect back to the instance tab to create an instance referencing that version (tplVersion query).
export function NewHarnessVersionForm({
  workspace,
  id,
  initialInstance,
  initialTemplate,
  startTab,
  notice,
  secrets,
}: {
  workspace: string
  id: string
  initialInstance: InstanceState
  initialTemplate: TemplateState
  startTab: Tab
  notice?: string
  secrets: ScopedSecretNames
}) {
  const router = useRouter()
  const t = useTranslations('harnessesPage')
  const [tab, setTab] = useState<Tab>(startTab)

  return (
    <div className="space-y-5">
      {notice && <Callout tone="info">{notice}</Callout>}

      <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
        <TabBtn active={tab === 'instance'} onClick={() => setTab('instance')}>
          {t('tabInstance')}
        </TabBtn>
        <TabBtn active={tab === 'template'} onClick={() => setTab('template')}>
          {t('tabTemplate')}
        </TabBtn>
      </div>

      <p className="text-[12px] text-muted-foreground">
        {tab === 'instance' ? t('instanceHint') : t('templateHint')}
      </p>

      {tab === 'instance' ? (
        <InstanceForm
          workspace={workspace}
          initial={initialInstance}
          lockId
          redirectDetailId={id}
          secrets={secrets}
          kind={initialTemplate.kind}
        />
      ) : (
        <TemplateForm
          workspace={workspace}
          initial={initialTemplate}
          lockId
          secrets={secrets}
          onRegistered={(version) =>
            router.push(
              `/${workspace}/harnesses/${encodeURIComponent(id)}/new-version?tab=instance&tplVersion=${encodeURIComponent(version)}`
            )
          }
        />
      )}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1 font-[510] transition-colors',
        active
          ? 'bg-card text-foreground shadow-raise'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}
