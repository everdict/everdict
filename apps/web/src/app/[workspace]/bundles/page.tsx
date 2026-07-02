import { ApplyBundleForm } from '@/features/apply-bundle'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default function BundlesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="번들"
        description="번들(하니스 + 벤치마크 + 데이터셋 + 런타임)을 한 번에 등록 — codex/pinch 같은 특화물은 번들으로."
      />
      <ApplyBundleForm />
    </div>
  )
}
