'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { File as FileIcon, Folder, FolderTree, Loader2, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { FsEntryView, FsUsageView } from '@/entities/workspace-file'
import { fmtBytes } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'

import { clearFilesAction, getFsUsageAction, removeEntryAction } from '../api/browse-files'
import { FilesWorkbench } from './files-workbench'

// Settings › Files — the workspace filesystem, mirrored entirely through the service (the user never touches
// MinIO): the EXPLORER on top (left = the tree, select a file → the right panel renders it — Markdown preview,
// code, images — with editing for members), the storage picture + cleanup below. The two halves stay in sync:
// a governance delete bumps the explorer's refresh token, an explorer mutation refreshes the usage numbers.
// Deletes = canWrite (files:write); the whole-tree clear = canManage (settings:write, admin).
export function FilesSettings({
  workspace,
  initialUsage,
  initialEntries,
  canWrite,
  canManage,
}: {
  workspace: string
  initialUsage: FsUsageView
  initialEntries: FsEntryView[]
  canWrite: boolean
  canManage: boolean
}) {
  const t = useTranslations('files')
  const [usage, setUsage] = useState<FsUsageView>(initialUsage)
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirm, setConfirm] = useState<{ kind: 'entry'; path: string } | { kind: 'all' } | null>(
    null
  )
  const [workbenchToken, setWorkbenchToken] = useState(0)
  const [pending, startTransition] = useTransition()

  function refresh() {
    startTransition(async () => {
      const res = await getFsUsageAction()
      if (res.ok && res.data) {
        setUsage(res.data)
        setError(undefined)
      } else setError(res.error)
    })
  }

  function runDelete() {
    if (confirm === null) return
    const target = confirm
    setConfirm(null)
    startTransition(async () => {
      const res =
        target.kind === 'all'
          ? await clearFilesAction()
          : await removeEntryAction(target.path, true)
      if (!res.ok) setError(res.error)
      // success → bump the explorer; its refresh sweep fires onMutated, which refreshes the usage numbers
      else setWorkbenchToken((token) => token + 1)
    })
  }

  return (
    <div className="space-y-6">
      {/* the explorer: left = the tree, select a file → the right panel renders it (+ the shell below) */}
      <FilesWorkbench
        initialEntries={initialEntries}
        canWrite={canWrite}
        refreshToken={workbenchToken}
        onMutated={refresh}
      />

      <div className="space-y-4">
        <p className="text-[13px] font-[510] text-foreground">{t('settingsStorageTitle')}</p>
        {/* totals strip */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
          <div>
            <p className="text-[11.5px] text-muted-foreground">{t('settingsTotalFiles')}</p>
            <p className="text-[15px] font-[560] text-foreground">
              {usage.files.toLocaleString()}
              {usage.truncated && <span className="text-muted-foreground">+</span>}
            </p>
          </div>
          <div>
            <p className="text-[11.5px] text-muted-foreground">{t('settingsTotalBytes')}</p>
            <p className="text-[15px] font-[560] text-foreground">{fmtBytes(usage.bytes)}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={refresh} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null} {t('refresh')}
            </Button>
            <Link
              href={`/${workspace}/files`}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
            >
              <FolderTree className="size-4" /> {t('settingsOpenBrowser')}
            </Link>
          </div>
        </div>
        {usage.truncated && (
          <p className="text-[12px] text-muted-foreground">{t('settingsTruncated')}</p>
        )}
        {error !== undefined && <p className="text-[12.5px] text-destructive">{error}</p>}

        {/* per-top-level breakdown */}
        {usage.topLevel.length === 0 ? (
          <EmptyState title={t('emptyRootTitle')} hint={t('emptyRootHint')} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {usage.topLevel.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-2.5 border-b border-border bg-card px-3.5 py-2 last:border-b-0"
              >
                {entry.kind === 'dir' ? (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
                  /{entry.path}
                  {entry.kind === 'dir' ? '/' : ''}
                </span>
                <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
                  {t('settingsEntryStats', { files: entry.files, size: fmtBytes(entry.bytes) })}
                </span>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('delete')}
                    title={t('delete')}
                    disabled={pending}
                    onClick={() => setConfirm({ kind: 'entry', path: entry.path })}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* danger zone — whole-tree wipe (admin) */}
        {canManage && (
          <div className="rounded-lg border border-destructive/40 bg-card px-4 py-3">
            <p className="text-[13px] font-[510] text-foreground">{t('settingsDangerTitle')}</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t('settingsDangerBody')}</p>
            <Button
              variant="destructive"
              size="sm"
              className="mt-2.5"
              disabled={pending || usage.files === 0}
              onClick={() => setConfirm({ kind: 'all' })}
            >
              <Trash2 /> {t('settingsClearAll')}
            </Button>
          </div>
        )}
      </div>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} className="max-w-sm">
        <div className="space-y-3 p-4">
          <p className="text-[13.5px] font-[510] text-foreground">
            {confirm?.kind === 'all'
              ? t('settingsClearAllTitle')
              : t('deleteTitle', { path: confirm?.kind === 'entry' ? `/${confirm.path}` : '' })}
          </p>
          <p className="text-[12.5px] text-muted-foreground">
            {confirm?.kind === 'all' ? t('settingsClearAllBody') : t('settingsDeleteEntryBody')}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={runDelete}>
              {t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
