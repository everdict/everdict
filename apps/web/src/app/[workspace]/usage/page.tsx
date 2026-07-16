import { redirect } from 'next/navigation'

// Usage is consolidated into the workspace Budget settings tab (budget limits + metered usage in one place). Keep the
// route as a redirect so old links/bookmarks still land somewhere sensible.
export default async function UsageRedirect({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  redirect(`/${workspace}/settings/budget`)
}
