'use client'

import { useState } from 'react'
import { GitMerge, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsWriteConflictView } from '@/entities/workspace-file'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Dialog } from '@/shared/ui/dialog'

import { languageFor } from '../lib/file-kind'

// What a member sees when their save lost a race — someone (a teammate, or an agent working in this workspace)
// published while they were editing. The dialog exists so that outcome is RESOLVABLE rather than a dead end: the
// server already merged the two versions, so the common case ("we edited different parts") is one click, and the
// hard case shows the conflicting hunks inline for the author to settle. Nothing is published until they say so.
//
// Whatever is published goes out against the revision that beat us — so the resolution itself takes part in the
// same optimistic protocol, and a THIRD publish landing meanwhile is caught too instead of silently overwritten.
export function MergeConflictDialog({
  conflict,
  path,
  mine,
  publishing,
  onPublish,
  onClose,
}: {
  conflict: FsWriteConflictView
  path: string
  mine: string // the draft that was refused
  publishing: boolean
  onPublish: (content: string, baseRevision: number) => void
  onClose: () => void
}) {
  const t = useTranslations('files')
  const auto = conflict.merge?.conflicts.length === 0
  const [text, setText] = useState(conflict.merge?.merged ?? mine)

  return (
    <Dialog open onClose={onClose} className="max-w-3xl">
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <GitMerge className="size-4 text-primary" />
          <p className="text-[13.5px] font-[510] text-foreground">{t('conflictTitle')}</p>
        </div>
        <Callout tone={auto ? 'info' : 'warning'}>
          {conflict.merge === undefined
            ? t('conflictNoMerge', { revision: conflict.headRevision })
            : auto
              ? t('conflictAutoMerged', { revision: conflict.headRevision })
              : t('conflictManual', {
                  revision: conflict.headRevision,
                  count: conflict.merge.conflicts.length,
                })}
        </Callout>
        {conflict.merge !== undefined ? (
          <CodeEditor
            value={text}
            onChange={setText}
            language={languageFor(path)}
            minHeight="320px"
            aria-label={t('mergedContent')}
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={publishing}>
            {t('cancel')}
          </Button>
          {/* Keeping only my version is a deliberate act, never the default — it discards what the other author
              published, so it stays a separate, plainly-labelled button. */}
          <Button
            variant="outline"
            size="sm"
            disabled={publishing}
            onClick={() => onPublish(mine, conflict.headRevision)}
          >
            {t('keepMine')}
          </Button>
          {conflict.merge !== undefined && (
            <Button
              variant="primary"
              size="sm"
              disabled={publishing}
              onClick={() => onPublish(text, conflict.headRevision)}
            >
              {publishing ? <Loader2 className="animate-spin" /> : <GitMerge />}
              {t('publishMerged')}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
