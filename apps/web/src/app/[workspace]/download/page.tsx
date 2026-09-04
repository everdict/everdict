import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// The desktop download was folded into the connection hub as one tab (/connect/desktop). Only a redirect remains, to preserve bookmarks and existing deep links.
export default async function DownloadPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  redirect(`/${workspace}/connect/desktop`)
}
