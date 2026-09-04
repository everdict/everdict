'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'

import { useDropdownClose } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import { issueStatusSchema, type IssueStatus } from '../model/schema'
import { IssueStatusIcon } from './issue-status-badge'

// A list for finding an issue by name and picking one — the trigger is drawn by the HOST (the same reason the label picker splits into
// `IssueLabelOptions` and `IssueLabelControl`: the same list is used by the issue detail's attribute row and by the harness detail's
// "link an issue" button).
//
// The NARROWING is the server's — every keystroke calls `/api/issues/search?q=` again. Taking one page and filtering here starts silently
// failing to find things the moment the workspace outgrows that page.

// How long (ms) to wait for typing to stop. So the server is not called once per character, while the result still arrives before a person
// feels "nothing is coming up".
const DEBOUNCE_MS = 200

export interface IssueOption {
  id: string
  identifier: string
  title: string
  status: IssueStatus
}

const issueOptionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      status: issueStatusSchema,
    })
  ),
})

export function IssueSearchOptions({
  exclude,
  onSelect,
  autoFocus,
}: {
  // The issues to exclude from the candidates — those already mentioned, and (on an issue detail) the issue itself.
  exclude?: string[]
  onSelect: (issue: IssueOption) => void
  autoFocus?: boolean
}) {
  const t = useTranslations('issueLinks')
  // Opened inside a popover, it closes after a pick — it is a list that picks ONE, so there is no reason to stay open. Used outside a
  // popover it does nothing (a hook that no-ops with no context).
  const close = useDropdownClose()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<IssueOption[]>([])
  const [loading, setLoading] = useState(true)

  const excluded = exclude?.join(' ') ?? ''
  useEffect(() => {
    // Cancellation has two layers: a request not yet sent is folded by the timer, one already in flight by the AbortController.
    // A late response for an older search term overwriting the current screen would make the list walk backwards through the typing.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      for (const id of excluded.split(' ').filter(Boolean)) params.append('exclude', id)
      setLoading(true)
      fetch(`/api/issues/search?${params.toString()}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((body) => setItems(issueOptionsSchema.parse(body).items))
        // A failed search is the same as having nothing to pick — errors are not piled into the list slot (the empty-list message answers).
        .catch(() => undefined)
        .finally(() => setLoading(false))
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, excluded])

  return (
    <div className="space-y-2">
      <Input
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('searchIssuePlaceholder')}
        // Guarding against the day this control sits inside a form — an Enter that submits the form would save mid-selection.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault()
        }}
      />
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {items.map((issue) => (
          <button
            key={issue.id}
            type="button"
            onClick={() => {
              close()
              onSelect(issue)
            }}
            title={`${issue.identifier} · ${issue.title}`}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <IssueStatusIcon status={issue.status} />
            <span className="shrink-0 font-mono text-[11.5px]">{issue.identifier}</span>
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          </button>
        ))}
        {items.length === 0 && (
          <p className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] text-faint">
            {loading ? <Loader2 className="size-3 animate-spin" /> : null}
            {loading ? t('searching') : t('noIssueMatch')}
          </p>
        )}
      </div>
    </div>
  )
}
