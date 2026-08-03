'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  ISSUE_CAPABILITY_LINK_TYPES,
  ISSUE_LINK_REF_KIND,
  issueLinkHref,
  type IssueLink,
  type IssueLinkType,
} from '@/entities/issue'
import { Button } from '@/shared/ui/button'
import { EntityRef } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

import { addIssueLinkAction, removeIssueLinkAction } from '../api/links'

export function IssueLinks({
  workspace,
  issueId,
  links,
  canWrite,
}: {
  workspace: string
  issueId: string
  links: IssueLink[]
  canWrite: boolean
}) {
  const t = useTranslations('issueLinks')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [type, setType] = useState<IssueLinkType>('harness')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('')
  const [pending, startTransition] = useTransition()

  // 이슈를 검증하는 능력만 — 스코어카드는 증거라서 "평가 이력" 섹션이 소유한다(ISSUE_CAPABILITY_LINK_TYPES).
  // 그래서 여기서 거는 것과 보이는 것이 같은 집합이다: 걸 수는 있는데 보이지 않는 종류를 만들지 않는다.
  const grouped = ISSUE_CAPABILITY_LINK_TYPES.map((kind) => ({
    kind,
    items: links.filter((l) => l.type === kind),
  })).filter((g) => g.items.length > 0)

  function add() {
    const trimmed = id.trim()
    if (trimmed.length === 0) return
    startTransition(async () => {
      const r = await addIssueLinkAction(issueId, {
        type,
        id: trimmed,
        ...(version.trim() ? { version: version.trim() } : {}),
      })
      if (!r.ok) {
        toast.error(r.error ?? t('addError'))
        return
      }
      setId('')
      setVersion('')
      setAdding(false)
      router.refresh()
    })
  }

  function remove(link: IssueLink) {
    startTransition(async () => {
      const r = await removeIssueLinkAction(issueId, link.type, link.id)
      if (!r.ok) {
        toast.error(r.error ?? t('removeError'))
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      {grouped.map((group) => (
        <div key={group.kind} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="w-20 shrink-0 text-[11px] font-[510] uppercase tracking-wide text-faint">
            {tracker(`linkType.${group.kind}`)}
          </span>
          {group.items.map((link) => (
            <span
              key={`${link.type}:${link.id}`}
              className="inline-flex max-w-full items-center gap-1 rounded bg-secondary py-0.5 pl-1.5 pr-1 text-[11px] text-secondary-foreground ring-1 ring-inset ring-border"
            >
              <Link
                href={issueLinkHref(workspace, link.type, link.id)}
                className="min-w-0 transition-colors hover:text-foreground"
                title={link.note ?? link.id}
              >
                <EntityRef
                  id={link.id}
                  version={link.version}
                  kind={ISSUE_LINK_REF_KIND[link.type]}
                />
              </Link>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => remove(link)}
                  disabled={pending}
                  aria-label={t('remove')}
                  className="rounded p-0.5 text-faint transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      ))}

      {canWrite &&
        (adding ? (
          <form
            className="@container flex flex-col gap-2 rounded-lg border border-dashed p-3 @sm:flex-row @sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <div className="w-full space-y-1.5 @sm:w-40">
              <Label htmlFor="link-type">{t('fieldType')}</Label>
              <Combobox
                id="link-type"
                value={type}
                onChange={(v) => setType(v as IssueLinkType)}
                options={ISSUE_CAPABILITY_LINK_TYPES.map((k) => ({
                  value: k,
                  label: tracker(`linkType.${k}`),
                }))}
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="link-id">{t('fieldId')}</Label>
              <Input
                id="link-id"
                value={id}
                autoFocus
                onChange={(e) => setId(e.target.value)}
                placeholder={t('fieldIdPlaceholder')}
              />
            </div>
            <div className="w-full space-y-1.5 @sm:w-32">
              <Label htmlFor="link-version">{t('fieldVersion')}</Label>
              <Input
                id="link-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder={t('fieldVersionAny')}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending || id.trim().length === 0}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('add')}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(false)}>
                {t('cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t('add')}
          </Button>
        ))}
    </div>
  )
}
