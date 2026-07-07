import { getTranslations } from 'next-intl/server'

import { RegisterRuntimeForm } from '@/features/register-runtime'
import { PageHeader } from '@/shared/ui/page-header'

// Runtime registration screen — the target of the 'Register runtime' button on the "Runtimes" list. Registers workspace-owned infra (docker/nomad/k8s/topology)
// (push runtimes). "My machine" connects via a runner (separate). Credentials are referenced by SecretStore key name, not by value.
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
