'use client'

import { useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { LabelChip, type IssueLabel } from '@/entities/issue-label'
import { useRefresh } from '@/shared/lib/use-refresh'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'

import { updateIssueAction } from '../api/issues'
import { toggleLabelId, withCreatedLabels } from '../lib/label-selection'
import { IssueLabelOptions, RemovableLabelChip } from './issue-label-picker'

// 이슈의 라벨 — 상태·우선순위·팀과 같은 자리(속성 열)에서 바로 바꾼다. 예전에는 칩만 그리고 편집은 ⋯ 메뉴의
// 다이얼로그 안에만 있었는데, 라벨 하나 떼려고 이슈 전체 폼을 열게 하는 건 Linear 의 동선이 아니다.
//
// 붙이기·떼기는 즉시 저장한다(폼이 아니라 컨트롤이다). 저장 결과를 기다리는 동안에도 칩은 바뀐 대로 보이고,
// 거절당하면 되돌린 뒤 제어 평면의 사유를 그대로 보여 준다.
export function IssueLabelControl({
  id,
  labelIds,
  labels,
  canWrite,
}: {
  id: string
  labelIds: string[]
  // 워크스페이스 라벨 레지스트리 — 고를 대상이자 칩을 그리는 근거.
  labels: IssueLabel[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [created, setCreated] = useState<IssueLabel[]>([])
  const [selected, setSelected] = useState(labelIds)
  const [seen, setSeen] = useState(labelIds.join(' '))
  const [pending, setPending] = useState(false)

  // 서버가 실어 온 값이 진실이다 — 저장이 끝나 페이지가 새로 그려졌거나 다른 화면이 고쳤으면 거기에 맞춘다.
  // 저장 중에는 맞추지 않는다: 연달아 두 번 토글하면 첫 응답이 두 번째 선택을 되돌려 깜빡인다.
  const fromServer = labelIds.join(' ')
  if (!pending && fromServer !== seen) {
    setSeen(fromServer)
    setSelected(labelIds)
  }

  const known = useMemo(() => withCreatedLabels(labels, created), [labels, created])
  const byId = useMemo(() => Object.fromEntries(known.map((l) => [l.id, l])), [known])
  // 정의가 사라진 id 는 그리지 않는다 — 삭제가 이슈에서 id 를 같이 떼어내므로 정상 경로에서는 생기지 않는다.
  const chips = selected.map((x) => byId[x]).filter((l): l is IssueLabel => l !== undefined)

  function apply(next: string[]): void {
    const previous = selected
    setSelected(next)
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(id, { labelIds: next })
        if (!r.ok) {
          setSelected(previous)
          toast.error(r.error ?? t('labelsError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  if (!canWrite) {
    if (chips.length === 0) return null
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {chips.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
      </span>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips.map((label) => (
        <RemovableLabelChip
          key={label.id}
          label={label}
          disabled={pending}
          onRemove={() => apply(toggleLabelId(selected, label.id))}
          removeLabel={t('labelRemove', { name: label.name })}
        />
      ))}
      <DropdownMenu
        align="end"
        contentClassName="w-64 p-2"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('labelsControlLabel')}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
          >
            {pending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            {/* 아직 아무것도 안 붙은 이슈에서는 이 버튼이 유일한 안내다 — 그때만 글자를 단다. */}
            {chips.length === 0 && <span>{t('labelAdd')}</span>}
          </button>
        )}
      >
        <IssueLabelOptions
          labels={known}
          selected={selected}
          canCreate
          autoFocus
          onToggle={(labelId) => apply(toggleLabelId(selected, labelId))}
          onCreated={(label) => {
            setCreated((prev) => [...prev, label])
            apply([...selected, label.id])
          }}
        />
      </DropdownMenu>
    </div>
  )
}
