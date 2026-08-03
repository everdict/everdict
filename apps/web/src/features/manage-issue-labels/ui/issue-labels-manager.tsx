'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  LabelColorPicker,
  LabelDot,
  type IssueLabel,
  type IssueLabelColor,
} from '@/entities/issue-label'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList } from '@/shared/ui/settings-list'

import {
  createIssueLabelAction,
  deleteIssueLabelAction,
  issueLabelUsageAction,
  updateIssueLabelAction,
} from '../api/manage-issue-labels'

// Settings › Labels — 워크스페이스의 분류 어휘. 이슈는 이 목록의 id 를 가리키므로 여기서의 이름/색 변경은
// 그 라벨을 단 모든 이슈에 한 번에 반영된다(문자열 시절에는 불가능했던 성질).
//
// 색 고르개는 `entities/issue-label` 의 것을 쓴다 — 이슈 화면의 선택기도 같은 물건으로 고른다.
export function IssueLabelsManager({
  labels,
  canWrite,
}: {
  labels: IssueLabel[]
  canWrite: boolean
}) {
  const t = useTranslations('labelsPage')
  const router = useRouter()
  const formId = useId()
  const [error, setError] = useState<string>()
  // 편집 중인 라벨(undefined = 새로 만들기). 다이얼로그 하나가 두 흐름을 다 맡는다 — 필드가 같기 때문이다.
  const [editing, setEditing] = useState<IssueLabel | undefined>()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState<IssueLabelColor>('gray')
  const [description, setDescription] = useState('')
  const [removing, setRemoving] = useState<{ label: IssueLabel; issues: number | undefined }>()
  const [pending, startTransition] = useTransition()

  function openCreate(): void {
    setEditing(undefined)
    setName('')
    setColor('gray')
    setDescription('')
    setError(undefined)
    setOpen(true)
  }

  function openEdit(label: IssueLabel): void {
    setEditing(label)
    setName(label.name)
    setColor(label.color)
    setDescription(label.description ?? '')
    setError(undefined)
    setOpen(true)
  }

  function submit(): void {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    startTransition(async () => {
      const current = editing
      const r = current
        ? await updateIssueLabelAction(current.id, {
            ...(trimmed !== current.name ? { name: trimmed } : {}),
            ...(color !== current.color ? { color } : {}),
            // PATCH semantics: 비운 설명은 명시적 null 로 가야 지워진다.
            ...(description.trim() !== (current.description ?? '')
              ? { description: description.trim() === '' ? null : description.trim() }
              : {}),
          })
        : await createIssueLabelAction({
            name: trimmed,
            color,
            ...(description.trim() ? { description: description.trim() } : {}),
          })
      if (!r.ok) {
        setError(r.error ?? t('saveError'))
        return
      }
      setOpen(false)
      router.refresh()
    })
  }

  // 삭제는 되돌릴 수 없고 이슈에서 라벨을 떼어낸다 — 몇 개인지 먼저 읽어 보여준 다음 확인받는다.
  function askRemove(label: IssueLabel): void {
    setRemoving({ label, issues: undefined })
    startTransition(async () => {
      const usage = await issueLabelUsageAction(label.id)
      setRemoving({ label, issues: usage?.issues })
    })
  }

  function confirmRemove(): void {
    const target = removing?.label
    if (!target) return
    startTransition(async () => {
      const r = await deleteIssueLabelAction(target.id)
      if (!r.ok) {
        toast.error(r.error ?? t('deleteError'))
        return
      }
      setRemoving(undefined)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {labels.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          action={
            canWrite ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-3.5" />
                {t('create')}
              </Button>
            ) : null
          }
        />
      ) : (
        <SettingsList>
          {labels.map((label) => (
            <li
              key={label.id}
              className="flex min-h-[60px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 items-center gap-2">
                <LabelDot color={label.color} />
                <span className="truncate text-[13px] font-[510] text-foreground">
                  {label.name}
                </span>
                {label.description && (
                  <span className="truncate text-[12px] text-muted-foreground">
                    {label.description}
                  </span>
                )}
              </div>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('edit', { name: label.name })}
                    onClick={() => openEdit(label)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('delete', { name: label.name })}
                    onClick={() => askRemove(label)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </SettingsList>
      )}

      {canWrite && labels.length > 0 && (
        <Button size="sm" variant="secondary" onClick={openCreate}>
          <Plus className="size-3.5" />
          {t('create')}
        </Button>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        className="max-w-md"
        labelledBy={`${formId}-title`}
      >
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h2 id={`${formId}-title`} className="text-[15px] font-[560] text-foreground">
            {editing ? t('editTitle') : t('createTitle')}
          </h2>
          {error !== undefined && <Callout tone="danger">{error}</Callout>}
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>{t('fieldName')}</Label>
            <Input
              id={`${formId}-name`}
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={t('fieldNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <span id={`${formId}-color`} className="block text-[13px] font-[510] text-foreground">
              {t('fieldColor')}
            </span>
            <LabelColorPicker value={color} onChange={setColor} labelledBy={`${formId}-color`} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-description`}>{t('fieldDescription')}</Label>
            <Input
              id={`${formId}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('fieldDescriptionPlaceholder')}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={pending || name.trim().length === 0}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {editing ? t('save') : t('createSubmit')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        className="max-w-md"
        labelledBy={`${formId}-delete-title`}
      >
        <div className="space-y-4 p-5">
          <h2 id={`${formId}-delete-title`} className="text-[15px] font-[560] text-foreground">
            {t('deleteTitle')}
          </h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {/* 아직 세는 중이면 개수를 약속하지 않는다 — 틀린 숫자보다 없는 숫자가 낫다. */}
            {removing?.issues === undefined
              ? t('deleteBody', { name: removing?.label.name ?? '' })
              : t('deleteBodyCounted', {
                  name: removing.label.name,
                  count: removing.issues,
                })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRemoving(undefined)}
            >
              {t('cancel')}
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={confirmRemove}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('deleteConfirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
