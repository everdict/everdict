import { HarnessTemplateListView } from '@/widgets/harness-template-list'

export const dynamic = 'force-dynamic'

// The shape (template) catalog — "what shapes exist". The harnesses actually used for evaluation are at `/{workspace}/harnesses`.
export default async function HarnessTemplatesPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  return <HarnessTemplateListView workspace={workspace} />
}
