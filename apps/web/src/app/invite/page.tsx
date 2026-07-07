import { getTranslations } from 'next-intl/server'

import { AcceptInviteCard } from '@/features/accept-invite'
import { invitePreviewSchema, type InvitePreview } from '@/entities/member'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Invite-accept page — the entry point for the shared link `/invite?token=…` (before joining there's no workspace slug, so a top-level route).
// Doesn't auto-accept on GET (avoids burning the one-time token on prefetch); redeem only via the card's button (POST action).
// Auth is enforced by the action (human account / OIDC only) — on a successful accept, enter that workspace (/{workspace}).
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const t = await getTranslations('invitePage')
  const token = typeof sp.token === 'string' ? sp.token : undefined

  // Non-consuming preview — shows "which workspace" (name/thumbnail) even before login (the server only validates the token).
  // On failure (invalid/expired/revoked or a transient error) show only the accept card without the header — the real reason is delivered by the accept action.
  let preview: InvitePreview | undefined
  if (token) {
    try {
      const ctx = await authContext()
      preview = invitePreviewSchema.parse(await controlPlane.previewInvite(ctx, token))
    } catch {
      preview = undefined
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-6 py-16">
      {!token ? (
        <>
          <PageHeader title={t('title')} description={t('description')} />
          <EmptyState title={t('invalidTitle')} hint={t('invalidHint')} />
        </>
      ) : (
        <>
          {preview ? (
            <WorkspaceInviteHeader preview={preview} />
          ) : (
            <PageHeader title={t('title')} description={t('description')} />
          )}
          <Card className="p-4">
            <AcceptInviteCard token={token} />
          </Card>
        </>
      )}
    </main>
  )
}

// Invite landing header — workspace thumbnail (logo, else initials) + name + invited role. See which workspace at a glance.
async function WorkspaceInviteHeader({ preview }: { preview: InvitePreview }) {
  const t = await getTranslations('invitePage')
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {preview.logoUrl ? (
        // An upload data URL / external URL, so a plain img rather than next/image (remote whitelist).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.logoUrl}
          alt=""
          className="size-16 rounded-2xl border border-border object-cover shadow-raise"
        />
      ) : (
        <div className="flex size-16 items-center justify-center rounded-2xl border border-border bg-secondary text-2xl font-[560] text-muted-foreground shadow-raise">
          {preview.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="space-y-1">
        <h1 className="text-xl font-[560] text-foreground">{preview.name}</h1>
        <p className="text-[13px] text-muted-foreground">
          {t.rich('invitedAs', {
            role: preview.role,
            strong: (chunks) => <span className="font-[510] text-foreground">{chunks}</span>,
          })}
        </p>
      </div>
    </div>
  )
}
