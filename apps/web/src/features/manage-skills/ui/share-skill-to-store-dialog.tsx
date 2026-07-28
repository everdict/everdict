'use client'

import { useState, useTransition } from 'react'
import { Store } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Skill } from '@/entities/skill'
import { saveCapabilityAction } from '@/features/publish-capability'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'

// 스킬 → 스토어 발행. 워크스페이스 스킬(living doc)을 capability 스토어의 버전드 skill 자산으로 퍼블리시한다 —
// upsert 라 재발행이 곧 갱신(콘텐츠 변경 시 패치 범프, 동일하면 no-op). 이후 이곳의 수정은 자동 반영되지 않는다
// (스토어는 불변 버전, 스킬은 제자리 편집 — 갱신하려면 다시 발행).
export function ShareSkillToStoreDialog({
  skill,
  isAdmin,
  onClose,
}: {
  skill: Skill
  isAdmin: boolean
  onClose: () => void
}) {
  const t = useTranslations('skillsManager')
  // 스토어 id 는 kebab 관례 — 스킬 이름에서 제안하되 편집 가능(같은 id 재발행 = 같은 자산의 새 버전).
  const [capId, setCapId] = useState(
    skill.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
  const [reach, setReach] = useState<'private' | 'workspace' | 'public'>('workspace')
  const [pending, startTransition] = useTransition()

  const reachOptions = [
    { value: 'workspace', label: t('reachWorkspace') },
    { value: 'private', label: t('reachPrivate') },
    // public 발행은 admin 게이트(컨트롤플레인 강제) — 비admin 에겐 보기부터 제외.
    ...(isAdmin ? [{ value: 'public', label: t('reachPublic') }] : []),
  ]

  const publish = () =>
    startTransition(async () => {
      const r = await saveCapabilityAction(capId, {
        name: skill.name,
        description: skill.description,
        spec: { type: 'skill', instructions: skill.instructions, files: skill.files },
        visibility: reach,
      })
      if (r.ok && r.result) {
        toast.success(t('publishedToStore', { name: skill.name, version: r.result.version }))
        onClose()
      } else {
        toast.error(r.error ?? t('publishError'))
      }
    })

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Store className="size-4 text-primary" />
            {t('shareToStoreTitle')}
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('shareToStoreHint')}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="share-cap-id">{t('capabilityId')}</Label>
          <Input
            id="share-cap-id"
            value={capId}
            onChange={(e) => setCapId(e.target.value)}
            className="font-mono text-[13px]"
          />
        </div>

        <div className="space-y-1">
          <Label>{t('reach')}</Label>
          <Combobox
            value={reach}
            onChange={(v) => setReach(v as 'private' | 'workspace' | 'public')}
            options={reachOptions}
          />
        </div>

        {/* 무엇이 발행되는지 요약 — 본문 + 파일 수 (내용 미리보기는 스토어 상세가 담당) */}
        <p className="text-[12px] text-muted-foreground">
          {t('shareToStoreSummary', { name: skill.name, count: skill.files.length })}
        </p>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={publish} disabled={pending || capId.trim().length === 0}>
            <Store />
            {pending ? t('publishing') : t('publish')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
