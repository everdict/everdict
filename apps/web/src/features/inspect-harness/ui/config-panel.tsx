import { Layers, Pin } from 'lucide-react'

import {
  templateSlotNames,
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
} from '@/entities/harness'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

import { Field, Mono, SubSection } from './parts'

// 구성(Config) — resolve 전 원본: 어떤 템플릿(대분류) 위에서 슬롯마다 어떤 값을 핀했는가.
// resolved "구성" 탭(병합된 최종 스펙)과 달리, 여기 값들이 곧 "새 버전 만들기"의 편집 대상이다.
export function ConfigPanel({
  instance,
  template,
}: {
  instance: HarnessInstanceSpec
  template: HarnessTemplateSpec
}) {
  const slots = templateSlotNames(template)
  // command 템플릿은 image/model 슬롯에 템플릿 기본값이 있을 수 있다(인스턴스가 override).
  const defaultFor = (slot: string): string | undefined =>
    template.kind === 'command'
      ? slot === 'image'
        ? template.image
        : slot === 'model'
          ? template.model
          : undefined
      : undefined

  return (
    <div className="space-y-7">
      <SubSection title="템플릿 (대분류)" icon={<Layers className="size-4" />}>
        <Card>
          <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <Field
              label="참조"
              value={
                <Mono>
                  {template.id}@{template.version}
                </Mono>
              }
              mono={false}
            />
            <Field label="kind" value={template.kind} />
            <Field label="category" value={template.category} />
            <Field label="구조 버전" value={template.version} />
          </dl>
        </Card>
      </SubSection>

      <SubSection title="Pins (슬롯 → 값)" icon={<Pin className="size-4" />} count={slots.length}>
        {slots.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            핀할 슬롯이 없습니다 (process 템플릿).
          </p>
        ) : (
          <Card className="divide-y divide-border">
            {slots.map((slot) => {
              const pinned = instance.pins[slot]
              const fallback = defaultFor(slot)
              const value = pinned ?? fallback
              return (
                <div
                  key={slot}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="font-mono text-[12.5px] font-[560] text-foreground">{slot}</span>
                  <div className="flex min-w-0 items-center gap-2">
                    {value ? (
                      <span
                        className="truncate font-mono text-[12px] text-muted-foreground"
                        title={value}
                      >
                        {value}
                      </span>
                    ) : (
                      <span className="text-[12px] text-muted-foreground">미설정</span>
                    )}
                    {!pinned && fallback && <Badge tone="outline">템플릿 기본</Badge>}
                  </div>
                </div>
              )
            })}
          </Card>
        )}
      </SubSection>
    </div>
  )
}
