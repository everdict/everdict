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
  return (
    <div className="space-y-8">
      <PageHeader
        title="런타임 등록"
        description="워크스페이스가 접속해 평가를 배치할 실행 인프라를 등록해요. 자격증명(토큰·kubeconfig)은 값이 아니라 시크릿 이름으로 참조합니다."
      />
      <RegisterRuntimeForm workspace={workspace} />
    </div>
  )
}
