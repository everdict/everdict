import { redirect } from 'next/navigation'

// Team shared runners were consolidated into the Runtimes surface — personal self-hosted, team self-hosted, and
// registered infra now live in one place ("where evaluations run"). The Settings › Runners nav entry was removed;
// this route stays only as a redirect for old links (CI setup dialog, legacy ?tab=runners).
export default async function RunnersPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  redirect(`/${workspace}/runtimes`)
}
