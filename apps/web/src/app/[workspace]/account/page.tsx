import { redirect } from 'next/navigation'

// The personal account settings moved into the unified Settings area (Account group). Keep this route as a
// redirect so old links/bookmarks (incl. ?tab=) still land on the matching section.
export default async function AccountRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { workspace } = await params
  const { tab } = await searchParams
  const section = tab === 'secrets' ? 'personal-secrets' : tab === 'keys' ? 'api-keys' : 'profile'
  redirect(`/${workspace}/settings/${section}`)
}
