'use client'

import { ShieldAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

// A write (mutating) tool call the agent paused on, awaiting the member's decision. `input` is the tool's raw
// arguments — shown compactly so the member sees exactly what would run before allowing it.
export interface PendingPermission {
  requestId: string
  name: string
  input: unknown
}

function previewInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  } catch {
    return ''
  }
}

// The inline approval strip: one card per parked write-tool call, with Allow / Deny. Rendered between the transcript
// and the composer so the member can't miss it while the turn is blocked.
export function PermissionPrompt({
  pending,
  onDecide,
}: {
  pending: PendingPermission[]
  onDecide: (requestId: string, decision: 'allow' | 'deny') => void
}) {
  const t = useTranslations('agentChat')
  if (pending.length === 0) return null
  return (
    <div className="flex flex-col gap-2 border-t border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
      {pending.map((p) => {
        const preview = previewInput(p.input)
        return (
          <div key={p.requestId} className="flex gap-2.5">
            <div className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-500">
              <ShieldAlert className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-[12.5px] font-[560] text-foreground">{t('permissionTitle')}</p>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t('permissionBody', { tool: p.name })}
              </p>
              {preview.length > 0 && (
                <pre className="max-h-40 overflow-auto rounded-md border border-border bg-card/60 px-2 py-1.5 text-[11.5px] leading-snug text-foreground/80">
                  {preview}
                </pre>
              )}
              <div className="flex gap-2 pt-0.5">
                <Button size="sm" onClick={() => onDecide(p.requestId, 'allow')}>
                  {t('permissionAllow')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onDecide(p.requestId, 'deny')}>
                  {t('permissionDeny')}
                </Button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
