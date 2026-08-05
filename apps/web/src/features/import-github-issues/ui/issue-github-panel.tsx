'use client'

import { useState } from 'react'
import { Github, Link2, Loader2, RefreshCw, Unlink } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueAttachmentProxy, type Issue } from '@/entities/issue'
import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { Dialog } from '@/shared/ui/dialog'
import { Markdown } from '@/shared/ui/markdown'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  detachIssueGithubAction,
  pullIssueAction,
  setIssueGithubSyncAction,
} from '../api/import-github-issues'

// The remote half of an imported issue. Narrowed off the record rather than re-declared, so a wire change to the
// GitHub block reaches this panel through the entity's drift guard.
type IssueGithub = NonNullable<Issue['github']>

const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

// The GitHub link on an imported issue: where it came from, which way it syncs, and the thread GitHub owns.
// Everything here is MANUAL — there is no webhook and no sweep, so "synced" is as of the last time someone asked.
export function IssueGithubPanel({
  issueId,
  github,
  canWrite,
}: {
  issueId: string
  github: IssueGithub
  canWrite: boolean
}) {
  const t = useTranslations('issueGithub')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)
  const [detaching, setDetaching] = useState(false)

  function sync() {
    void (async () => {
      setPending(true)
      try {
        const r = await pullIssueAction(issueId)
        if (!r.ok) {
          toast.error(r.error ?? t('syncError'))
          return
        }
        toast.success(t('syncDone'))
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function setSync(next: { pull: boolean; push: boolean }) {
    void (async () => {
      setPending(true)
      try {
        const r = await setIssueGithubSyncAction(issueId, next)
        if (!r.ok) {
          toast.error(r.error ?? t('syncSettingError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function detach() {
    void (async () => {
      setPending(true)
      try {
        const r = await detachIssueGithubAction(issueId)
        if (!r.ok) {
          toast.error(r.error ?? t('detachError'))
          return
        }
        setDetaching(false)
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-muted-foreground">
            <a
              href={github.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 font-mono text-foreground transition-colors hover:text-primary"
            >
              <Github className="size-3.5 shrink-0 text-faint" />
              <span className="truncate">
                {github.repository}#{github.number}
              </span>
            </a>
            {github.host && <Badge tone="outline">{hostLabel(github.host)}</Badge>}
            <Badge tone={github.state === 'closed' ? 'neutral' : 'success'}>
              {t(`remoteState.${github.state}`)}
            </Badge>
            {github.syncedAt && (
              <span title={fmtDateTimeFull(github.syncedAt, { timeZone })}>
                {t('syncedAt', { at: fmtTimeAgo(github.syncedAt, locale, timeZone) })}
              </span>
            )}
          </div>
          {canWrite && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" size="sm" disabled={pending} onClick={sync}>
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t('syncNow')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setDetaching(true)}
              >
                <Unlink className="size-3.5" />
                {t('detach')}
              </Button>
            </div>
          )}
        </div>

        {/* A recorded failure is the only trace a manual sync leaves behind — surface the op that failed, its
            message, and the retry, rather than letting the panel look merely stale. */}
        {github.lastError && (
          <Callout
            tone="danger"
            hint={
              <span title={fmtDateTimeFull(github.lastError.at, { timeZone })}>
                {fmtTimeAgo(github.lastError.at, locale, timeZone)}
              </span>
            }
          >
            <p>
              {t(`lastErrorOp.${github.lastError.op}`)} — {github.lastError.message}
            </p>
            {canWrite && (
              <button
                type="button"
                onClick={sync}
                disabled={pending}
                className="mt-1.5 text-[12px] font-[510] underline-offset-2 hover:underline disabled:opacity-50"
              >
                {t('retry')}
              </button>
            )}
          </Callout>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/70 pt-3">
          <label className="flex items-center gap-2 text-[12.5px] text-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={github.sync.pull}
              disabled={!canWrite || pending}
              onChange={(e) => setSync({ pull: e.target.checked, push: github.sync.push })}
            />
            {t('pull')}
            <InfoTip content={t('pullTip')} />
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={github.sync.push}
              disabled={!canWrite || pending}
              onChange={(e) => setSync({ pull: github.sync.pull, push: e.target.checked })}
            />
            {t('push')}
            <InfoTip content={t('pushTip')} />
          </label>
        </div>
      </Card>

      {/* GitHub owns this thread: it is pulled read-only for context, and the tracker's own discussion lives in
          the comments section below. Mixing the two would put replies where nobody on GitHub can read them. */}
      {github.comments.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[12px] font-[510] uppercase tracking-wide text-faint">
              {t('commentsTitle')}
            </h3>
            <InfoTip content={t('commentsTip')} />
          </div>
          <ul className="space-y-2">
            {github.comments.map((comment) => (
              <li key={comment.url} className="rounded-lg border bg-card px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                  <span className="font-[510] text-foreground">{comment.author}</span>
                  <span title={fmtDateTimeFull(comment.createdAt, { timeZone })}>
                    {fmtTimeAgo(comment.createdAt, locale, timeZone)}
                  </span>
                  <a
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                  >
                    <Link2 className="size-3" />
                    {t('viewOnGithub')}
                  </a>
                </div>
                {/* 코멘트도 원격이 쓴 마크다운이다 — 설명과 같은 뷰어로 그려야 스크린샷·코드블록·표가 살아난다.
                    첨부 이미지는 설명과 똑같이 우리 프록시를 거친다(직접 받아올 수 없는 주소다). */}
                <Markdown
                  content={comment.body}
                  imageProxy={issueAttachmentProxy(issueId, github)}
                  className="mt-1.5"
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={detaching} onClose={() => setDetaching(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('detachTitle')}</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {/* The number travels as text: ICU would group a four-digit issue number into "1,234". */}
            {t('detachBody', { repository: github.repository, number: String(github.number) })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDetaching(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={detach}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('detach')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
