'use client'

import { useEffect, useId, useState, useTransition } from 'react'
import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { KNOWLEDGE_ENTRY_KINDS, type KnowledgeEntry, type NodeRefView } from '@/entities/knowledge'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'

import { createKnowledgeEntryAction, updateKnowledgeEntryAction } from '../api/manage-knowledge'

// 앵커/근거 ref 의 type 후보 — 닫힌 NodeType vocabulary 의 웹측 부분집합(자유입력 대신 흔한 것만 제시).
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

// 버전핀 NodeRef 행 편집기 — refs(앵커)와 evidence(근거)가 공유. 행 = type 콤보 + key + version(선택).
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
        // NodeRef 행은 안정 키가 없음(내용 자체가 편집 대상) — 인덱스 키 사용
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

// 지식 엔트리 작성/편집 다이얼로그 — create(initial 없음) / edit(initial 있음) 겸용. 저장 성공 시 onSaved(엔트리)로 알림.
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
  const [pending, startTransition] = useTransition()

  // 열릴 때마다 initial 로 리셋 — edit 재진입/다른 엔트리 편집 시 이전 폼 상태가 남지 않게.
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
    startTransition(async () => {
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
    })

  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl" labelledBy={titleId}>
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim() && body.trim()) submit()
        }}
      >
        <div className="space-y-1">
          <h2 id={titleId} className="text-sm font-semibold">
            {initial ? t('form.editTitle') : t('form.createTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('form.description')}</p>
        </div>

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

        <RefRows label={t('form.refs')} hint={t('form.refsHint')} rows={refs} onChange={setRefs} />
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

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" disabled={pending || !title.trim() || !body.trim()}>
            {pending ? t('form.saving') : initial ? t('form.save') : t('form.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
