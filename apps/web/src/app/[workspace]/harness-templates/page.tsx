import { HarnessTemplateListView } from '@/widgets/harness-template-list'

export const dynamic = 'force-dynamic'

// 형상(템플릿) 카탈로그 — "어떤 형상이 있는가". 실제 평가에 쓰는 하네스는 `/{workspace}/harnesses` 다.
export default async function HarnessTemplatesPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  return <HarnessTemplateListView workspace={workspace} />
}
