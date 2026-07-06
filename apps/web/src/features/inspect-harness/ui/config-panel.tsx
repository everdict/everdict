import { Layers, Pin, SlidersHorizontal } from 'lucide-react'

import {
  templateSlotNames,
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
} from '@/entities/harness'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

import { Mono, SubSection } from './parts'

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
  // 값이 하나라도 있는 슬롯이 있나 — 전부 미설정이면 Pins 섹션 자체를 숨긴다(빈 섹션 노출 금지).
  const anyPinned = slots.some((slot) => instance.pins[slot] ?? defaultFor(slot))

  return (
    <div className="space-y-7">
      {/* kind·category·버전은 상단 메타 스트립에 있으니 여기선 이 인스턴스가 올라탄 템플릿 참조만. */}
      <SubSection title="템플릿 (대분류)" icon={<Layers className="size-4" />}>
        <Card className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-[13px]">
          <span className="text-muted-foreground">참조</span>
          <Mono>
            {template.id}@{template.version}
          </Mono>
        </Card>
      </SubSection>

      {slots.length > 0 && anyPinned && (
        <SubSection title="Pins (슬롯 → 값)" icon={<Pin className="size-4" />} count={slots.length}>
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
        </SubSection>
      )}

      {instance.overrides && Object.keys(instance.overrides).length > 0 && (
        <SubSection title="변주 (overrides)" icon={<SlidersHorizontal className="size-4" />}>
          <Card>
            <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {JSON.stringify(instance.overrides, null, 2)}
            </pre>
          </Card>
          <p className="mt-2 text-[12px] text-muted-foreground">
            구조(템플릿)는 그대로 두고 동작만 바꾸는 델타 — resolve 시 템플릿 위에 병합됩니다.
          </p>
        </SubSection>
      )}
    </div>
  )
}
