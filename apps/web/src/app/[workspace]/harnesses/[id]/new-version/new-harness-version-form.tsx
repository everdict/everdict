'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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

// 하니스 새 버전 — 두 축: 인스턴스(pins 재핀 → 새 인스턴스 버전) | 템플릿(구조 변경 → 새 템플릿 semver).
// 템플릿 새 버전 등록 후엔 그 버전을 참조하는 인스턴스를 만들도록 인스턴스 탭으로 돌려보낸다(tplVersion 쿼리).
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
  const [tab, setTab] = useState<Tab>(startTab)

  return (
    <div className="space-y-5">
      {notice && <Callout tone="info">{notice}</Callout>}

      <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
        <TabBtn active={tab === 'instance'} onClick={() => setTab('instance')}>
          인스턴스 (핀 교체)
        </TabBtn>
        <TabBtn active={tab === 'template'} onClick={() => setTab('template')}>
          템플릿 (구조)
        </TabBtn>
      </div>

      <p className="text-[12px] text-muted-foreground">
        {tab === 'instance'
          ? '슬롯 값(이미지·모델)만 바꿔 새 인스턴스 버전으로 등록해요. 템플릿 구조는 그대로예요.'
          : '구조를 바꿔 새 템플릿 버전을 만들어요. 그다음 이 버전으로 인스턴스를 만들면 돼요.'}
      </p>

      {tab === 'instance' ? (
        <InstanceForm
          workspace={workspace}
          initial={initialInstance}
          lockId
          redirectDetailId={id}
          secrets={secrets}
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
