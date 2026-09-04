'use client'

import { useEffect, useId, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { KNOWLEDGE_ENTRY_KINDS, type KnowledgeEntry, type NodeRefView } from '@/entities/knowledge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'

import { createKnowledgeEntryAction, updateKnowledgeEntryAction } from '../api/manage-knowledge'

// The type candidates for an anchor/evidence ref — the web-side subset of the closed NodeType vocabulary (offering the common ones rather than free input).
const REF_TYPES = [
  'harness',
  'dataset',
  'judge',
  'model',
  'runtime',
  'rubric',
  'agent',
  'scorecard',
  'run',
  'case',
  'capability',
  'skill',
] as const

// The version-pinned NodeRef row editor — shared by refs (anchors) and evidence (grounds). A row = a type combo + key + an optional version.
function RefRows({
  label,
  hint,
  rows,
  onChange,
}: {
  label: string
  hint: string
  rows: NodeRefView[]
  onChange: (rows: NodeRefView[]) => void
}) {
  const t = useTranslations('knowledge')
  const set = (i: number, patch: Partial<NodeRefView>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
      {rows.map((r, i) => (
        // A NodeRef row has no stable key (its CONTENT is what is being edited) — an index key is used
        <div key={i} className="flex items-center gap-1.5">
          <Combobox
            options={REF_TYPES.map((v) => ({ value: v, label: v }))}
            value={r.type}
            onChange={(v) => set(i, { type: v })}
            className="w-32 shrink-0"
          />
          <Input
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder={t('form.keyPlaceholder')}
            className="flex-1"
          />
          <Input
            value={r.version ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim()
              set(i, v === '' ? { version: undefined } : { version: v })
            }}
            placeholder={t('form.versionPlaceholder')}
            className="w-24 shrink-0"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('form.removeRef')}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onChange([...rows, { type: 'harness', key: '' }])}
        >
          <Plus className="size-3.5" /> {t('form.addRef')}
        </Button>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
    </fieldset>
  )
}

// The knowledge entry create/edit dialog — it serves both create (no `initial`) and edit (with `initial`). On a successful save it reports through onSaved(entry).
export function EntryFormDialog({
  open,
  onClose,
  initial,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  initial?: KnowledgeEntry
  onSaved?: (entry: KnowledgeEntry) => void
}) {
  const t = useTranslations('knowledge')
  const titleId = useId()
  const [kind, setKind] = useState<(typeof KNOWLEDGE_ENTRY_KINDS)[number]>('finding')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [refs, setRefs] = useState<NodeRefView[]>([])
  const [evidence, setEvidence] = useState<NodeRefView[]>([])
  const [shared, setShared] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  // Reset to `initial` every time it opens — so no previous form state survives re-entering an edit or editing a different entry.
  useEffect(() => {
    if (!open) return
    setKind(initial?.kind ?? 'finding')
    setTitle(initial?.title ?? '')
    setBody(initial?.body ?? '')
    setRefs(initial?.refs ?? [])
    setEvidence(initial?.evidence ?? [])
    setShared(initial?.visibility === 'workspace')
    setError(undefined)
  }, [open, initial])

  const completeRefs = (rows: NodeRefView[]) => rows.filter((r) => r.key.trim() !== '')

  const submit = () =>
    void (async () => {
      setPending(true)
      try {
        setError(undefined)
        const payload = {
          kind,
          title: title.trim(),
          body: body.trim(),
          refs: completeRefs(refs),
          evidence: completeRefs(evidence),
          visibility: (shared ? 'workspace' : 'private') as 'workspace' | 'private',
        }
        const res = initial
          ? await updateKnowledgeEntryAction(initial.id, payload)
          : await createKnowledgeEntryAction(payload)
        if (!res.ok || !res.entry) {
          setError(res.error ?? t('actionFailed'))
          return
        }
        onSaved?.(res.entry)
        onClose()
      } finally {
        setPending(false)
      }
    })()

  // The same convention as the detail — the panel is bound to the viewport (85vh) and only the fields scroll, with the title and save/cancel pinned.
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="flex max-h-[85vh] max-w-2xl flex-col"
      labelledBy={titleId}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim() && body.trim()) submit()
        }}
      >
        <div className="shrink-0 space-y-1 border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-sm font-semibold">
            {initial ? t('form.editTitle') : t('form.createTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('form.description')}</p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">{t('form.kind')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {KNOWLEDGE_ENTRY_KINDS.map((k) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={kind === k ? 'primary' : 'secondary'}
                  onClick={() => setKind(k)}
                >
                  {t(`kinds.${k}`)}
                </Button>
              ))}
            </div>
          </fieldset>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('form.title')}</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('form.titlePlaceholder')}
              maxLength={300}
              required
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('form.body')}</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('form.bodyPlaceholder')}
              rows={8}
              required
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </label>

          <RefRows
            label={t('form.refs')}
            hint={t('form.refsHint')}
            rows={refs}
            onChange={setRefs}
          />
          <RefRows
            label={t('form.evidence')}
            hint={t('form.evidenceHint')}
            rows={evidence}
            onChange={setEvidence}
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
              className="size-4 accent-[var(--color-primary)]"
            />
            {t('form.shareToWorkspace')}
          </label>
        </div>

        <div className="shrink-0 space-y-2 border-t border-border px-5 py-3">
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('form.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !title.trim() || !body.trim()}>
              {pending ? t('form.saving') : initial ? t('form.save') : t('form.create')}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
