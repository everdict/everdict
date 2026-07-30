import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { MentionInChatButton } from '@/widgets/infra-panel'
import { ToolDetail } from '@/features/manage-agent-tools'
import { agentToolDetailSchema, type AgentToolDetail } from '@/entities/agent-tool'
import { secretsSchema } from '@/entities/secret'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Agent › Tools › 상세 — 목록의 스위치 뒤에 있는 것. 이 도구가 어떻게 도달되고, 모델 앞에 어떤 function 을
// 어떤 이름으로 놓고, 모델이 읽는 description 이 무엇이고, 어떤 시크릿을 필요로 하는지. 그리고 정말 도는지(연결 테스트
// · 예제 실행). 상세는 언제나 라우트이지 다이얼로그가 아니다 — 오른쪽 대화 패널에서 이 도구를 두고 실험·편집해야 한다.
//
// 편집의 주 경로는 스킬 상세와 같은 "대화로 편집하기": 참조 칩을 떨어뜨리고 패널을 toolEdit 임무로 프레이밍한다.
// 에이전트가 get_capability 로 읽고 save_capability 로 새 버전을 낸다(HITL 승인) — 도구 스펙의 폼 편집은 스토어 소관.
// 이 워크스페이스가 소유한 capability 만 편집 가능(기본 제공 도구와 남의 발행물은 읽기 전용).
export default async function AgentToolDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key: raw } = await params
  const key = decodeURIComponent(raw)
  const t = await getTranslations('agentTools')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'capabilities:read')) {
    return <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
  }

  let tool: AgentToolDetail
  try {
    tool = agentToolDetailSchema.parse(await controlPlane.getAgentTool(ctx, key))
  } catch {
    notFound() // 내 도구셋에 없는 키 — 존재 누설 없이 404(컨트롤플레인이 판정한다)
  }

  // 바인딩 피커의 후보 — 워크스페이스 + 내 개인 시크릿 이름(값은 오지 않는다).
  let secretNames: string[] = []
  try {
    secretNames = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .map((secret) => secret.name)
  } catch {
    // 시크릿 스토어 미구성 — 피커는 기존 이름 없이 새로 만들기만 제안한다.
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/settings/tools`}
        className="inline-flex items-center gap-1 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t('backToTools')}
      </Link>
      <PageHeader title={tool.name} description={tool.description} />
      <ToolDetail
        tool={tool}
        secretNames={secretNames}
        canBind={can(principal?.roles, 'agents:write')}
        actions={
          tool.editable && tool.capability ? (
            <MentionInChatButton
              reference={{
                type: 'tool',
                id: tool.capability.id,
                version: tool.capability.version,
                label: tool.name,
                source: tool.capability.source,
              }}
              label={t('editInChat')}
              mission="toolEdit"
            />
          ) : undefined
        }
      />
    </div>
  )
}
