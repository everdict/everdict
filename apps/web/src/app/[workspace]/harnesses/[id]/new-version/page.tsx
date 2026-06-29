import Link from 'next/link'
import { ChevronLeft, Lock } from 'lucide-react'

import {
  instanceStateFromSpec,
  templateStateFromSpec,
  type InstanceState,
  type TemplateState,
} from '@/features/register-harness'
import {
  harnessInstanceSpecSchema,
  harnessTemplateSpecSchema,
  harnessVersionsSchema,
  templateSlotNames,
} from '@/entities/harness'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { NewHarnessVersionForm } from './new-harness-version-form'

export const dynamic = 'force-dynamic'

// 하니스 새 버전 — 인스턴스(pins 재핀) | 템플릿(구조) 두 축. 모두 기존 구성을 프리필.
// 버전은 불변이라 "수정 = 새 버전". 같은 하니스라 id/kind 는 고정.
export default async function NewHarnessVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string; tab?: string; tplVersion?: string }>
}) {
  const { workspace, id } = await params
  const { v, tab, tplVersion } = await searchParams
  const ctx = await authContext()
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'harnesses:register')

  let initialInstance: InstanceState | undefined
  let initialTemplate: TemplateState | undefined
  let startTab: 'instance' | 'template' = tab === 'template' ? 'template' : 'instance'
  let notice: string | undefined
  let loadError: string | undefined
  try {
    const versions = harnessVersionsSchema.parse(await controlPlane.getHarness(ctx, id)).versions
    const active = (typeof v === 'string' && versions.includes(v) ? v : undefined) ?? versions[versions.length - 1]
    if (!active) throw new Error('등록된 버전이 없습니다.')
    const instance = harnessInstanceSpecSchema.parse(await controlPlane.getHarnessInstance(ctx, id, active))

    if (typeof tplVersion === 'string' && tplVersion) {
      // 템플릿 새 버전 등록 직후 — 그 버전을 참조하는 인스턴스를 만들도록 인스턴스 탭으로 복귀.
      const newTemplate = harnessTemplateSpecSchema.parse(await controlPlane.getHarnessTemplateSpec(ctx, id, tplVersion))
      initialInstance = instanceStateFromSpec(
        { ...instance, template: { id, version: tplVersion } },
        templateSlotNames(newTemplate)
      )
      initialTemplate = templateStateFromSpec(newTemplate)
      startTab = 'instance'
      notice = `템플릿 ${id}@${tplVersion} 가 등록됐습니다. 이 버전을 참조하는 새 인스턴스를 등록하세요.`
    } else {
      const template = harnessTemplateSpecSchema.parse(
        await controlPlane.getHarnessTemplateSpec(ctx, instance.template.id, instance.template.version)
      )
      initialInstance = instanceStateFromSpec(instance, templateSlotNames(template))
      initialTemplate = templateStateFromSpec(template)
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/harnesses/${encodeURIComponent(id)}`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {id}
      </Link>
      <PageHeader
        title="새 버전 만들기"
        description={`${id} 의 구성을 프리필했습니다. 값을 바꾸고 새 버전으로 등록하세요(버전 불변).`}
      />
      {!allowed ? (
        <EmptyState
          icon={<Lock />}
          title="하니스 등록 권한이 없습니다."
          hint="harnesses:register 권한이 필요합니다."
        />
      ) : loadError || !initialInstance || !initialTemplate ? (
        <Callout tone="danger">기존 구성을 불러올 수 없습니다: {loadError ?? '알 수 없는 오류'}</Callout>
      ) : (
        <Card className="p-5">
          <NewHarnessVersionForm
            workspace={workspace}
            id={id}
            initialInstance={initialInstance}
            initialTemplate={initialTemplate}
            startTab={startTab}
            {...(notice !== undefined ? { notice } : {})}
          />
        </Card>
      )}
    </div>
  )
}
