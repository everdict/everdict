import Link from 'next/link'
import { ChevronLeft, Lock } from 'lucide-react'

import { InstanceForm, instanceStateFromSpec, type InstanceState } from '@/features/register-harness'
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

export const dynamic = 'force-dynamic'

// 하니스(인스턴스) 새 버전 — 기존 버전의 pins/템플릿 참조를 프리필해 값만 바꿔 새 인스턴스 버전으로 등록.
// 버전은 불변이라 "수정 = 새 버전". 같은 하니스라 id 는 고정(lockId), 새 버전 태그만 입력.
export default async function NewHarnessVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { workspace, id } = await params
  const { v } = await searchParams
  const ctx = await authContext()
  const { principal } = await currentPrincipal()
  const allowed = can(principal?.roles, 'harnesses:register')

  // 출발 버전(없으면 latest)의 raw 인스턴스 + 템플릿 → 인스턴스 폼 프리필(슬롯 전부 펼침).
  let initial: InstanceState | undefined
  let loadError: string | undefined
  let baseVersion: string | undefined
  try {
    const versions = harnessVersionsSchema.parse(await controlPlane.getHarness(ctx, id)).versions
    const active = (typeof v === 'string' && versions.includes(v) ? v : undefined) ?? versions[versions.length - 1]
    if (!active) throw new Error('등록된 버전이 없습니다.')
    baseVersion = active
    const instance = harnessInstanceSpecSchema.parse(await controlPlane.getHarnessInstance(ctx, id, active))
    const template = harnessTemplateSpecSchema.parse(
      await controlPlane.getHarnessTemplateSpec(ctx, instance.template.id, instance.template.version)
    )
    initial = instanceStateFromSpec(instance, templateSlotNames(template))
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
        description={
          baseVersion
            ? `${id} · ${baseVersion} 의 구성을 프리필했습니다. 값을 바꾸고 새 버전 태그로 등록하세요.`
            : `${id} 의 새 인스턴스 버전을 등록합니다.`
        }
      />
      {!allowed ? (
        <EmptyState
          icon={<Lock />}
          title="하니스 등록 권한이 없습니다."
          hint="harnesses:register 권한이 필요합니다."
        />
      ) : loadError || !initial ? (
        <Callout tone="danger">기존 구성을 불러올 수 없습니다: {loadError ?? '알 수 없는 오류'}</Callout>
      ) : (
        <Card className="p-5">
          <InstanceForm workspace={workspace} initial={initial} lockId redirectDetailId={id} />
        </Card>
      )}
    </div>
  )
}
