'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { isPastDue } from '@/entities/project'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { createInitiativeAction } from '../api/initiatives'

export function CreateInitiativeButton({
  workspace,
  timeZone,
  initiatives,
}: {
  workspace: string
  // 상위로 걸 수 있는 이니셔티브들. 하나만 고르는 자리이므로 Combobox — 프로젝트의 팀/이니셔티브와 달리
  // 부모는 하나다.
  initiatives: { id: string; name: string }[]
  // 목표일이 이미 지났는지 판정할 기준. 목록의 "기한 초과" 배지와 같은 시간대를 써야 방금 만든 것이
  // 왜 초과로 보이는지가 어긋나지 않는다.
  timeZone: string
}) {
  const t = useTranslations('initiativesPage')
  const router = useRouter()
  // 이 버튼은 헤더와 빈 상태 두 곳에 놓인다 — 필드 id 를 인스턴스마다 갈라 두 개가 같은 id 를 쓰는 일이 없게 한다.
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [pending, startTransition] = useTransition()

  // 지난 날짜도 받는다 — 이미 넘긴 마감을 그대로 기록하는 건 정당하다. 다만 만들자마자 "기한 초과"로
  // 보일 거라는 사실은 저장 전에 알려준다.
  const targetIsPast = isPastDue(targetDate === '' ? undefined : targetDate, timeZone)

  function submit() {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    startTransition(async () => {
      const r = await createInitiativeAction({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(parentId ? { parentId } : {}),
        ...(targetDate ? { targetDate } : {}),
      })
      if (!r.ok || !r.initiative) {
        toast.error(r.error ?? t('createError'))
        return
      }
      setOpen(false)
      setName('')
      setDescription('')
      setParentId('')
      setTargetDate('')
      router.push(`/${workspace}/initiatives/${encodeURIComponent(r.initiative.id)}`)
    })
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t('create')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        className="max-w-lg"
        labelledBy={`${formId}-title`}
      >
        <form
          className="@container space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h2 id={`${formId}-title`} className="text-[15px] font-[560] text-foreground">
            {t('createTitle')}
          </h2>
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
            <Label htmlFor={`${formId}-description`}>{t('fieldDescription')}</Label>
            <Textarea
              id={`${formId}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('fieldDescriptionPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-parent`}>{t('fieldParent')}</Label>
            <Combobox
              id={`${formId}-parent`}
              value={parentId}
              onChange={setParentId}
              placeholder={t('fieldParentNone')}
              options={[
                { value: '', label: t('fieldParentNone') },
                ...initiatives.map((i) => ({ value: i.id, label: i.name })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-target`}>{t('fieldTargetDate')}</Label>
            <Input
              id={`${formId}-target`}
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
            {targetIsPast && (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t('fieldTargetDatePast')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            {/* 제출 라벨은 트리거("새 이니셔티브")와 달라야 한다 — 같은 글자면 무엇을 누르는지가 아니라
                어디를 누르는지로만 구분된다. 진행 중에도 라벨을 유지해 버튼 폭이 튀지 않게 한다. */}
            <Button type="submit" size="sm" disabled={pending || name.trim().length === 0}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('createSubmit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
