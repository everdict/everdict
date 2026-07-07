import { getTranslations } from 'next-intl/server'

import { RegisterRuntimeForm } from '@/features/register-runtime'
import { PageHeader } from '@/shared/ui/page-header'

// 런타임 등록 화면 — "런타임" 목록의 '런타임 등록' 버튼 대상. 워크스페이스 소유 인프라(docker/nomad/k8s/topology)를
// 등록한다(push 런타임). "내 머신"은 러너로 연결(별도). 자격증명은 값이 아니라 SecretStore 키 이름으로 참조.
export default async function NewRuntimePage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('runtimesPage')
  return (
    <div className="space-y-8">
      <PageHeader title={t('register')} description={t('registerDescription')} />
      <RegisterRuntimeForm workspace={workspace} />
    </div>
  )
}
