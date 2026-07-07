import { Layers, Pin, SlidersHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  templateSlotNames,
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
} from '@/entities/harness'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

import { Mono, SubSection } from './parts'

// Config — the pre-resolve original: on which template (the category) and what value was pinned per slot.
// Unlike the resolved "config" tab (the merged final spec), these values are exactly what "create a new version" edits.
export function ConfigPanel({
  instance,
  template,
}: {
  instance: HarnessInstanceSpec
  template: HarnessTemplateSpec
}) {
  const t = useTranslations('inspectHarness')
  const slots = templateSlotNames(template)
  // A command template may have template defaults for the image/model slots (the instance overrides them).
  const defaultFor = (slot: string): string | undefined =>
    template.kind === 'command'
      ? slot === 'image'
        ? template.image
        : slot === 'model'
          ? template.model
          : undefined
      : undefined
  // Is there any slot with a value — if all are unset, hide the Pins section entirely (no empty-section display).
  const anyPinned = slots.some((slot) => instance.pins[slot] ?? defaultFor(slot))

  return (
    <div className="space-y-7">
      {/* kind·category·version are in the top meta strip, so here only the template reference this instance rides on. */}
      <SubSection title={t('templateCategory')} icon={<Layers className="size-4" />}>
        <Card className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-[13px]">
          <span className="text-muted-foreground">{t('reference')}</span>
          <Mono>
            {template.id}@{template.version}
          </Mono>
        </Card>
      </SubSection>

      {slots.length > 0 && anyPinned && (
        <SubSection
          title={t('pinsSlotValue')}
          icon={<Pin className="size-4" />}
          count={slots.length}
        >
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
                      <span className="text-[12px] text-muted-foreground">{t('unset')}</span>
                    )}
                    {!pinned && fallback && <Badge tone="outline">{t('templateDefault')}</Badge>}
                  </div>
                </div>
              )
            })}
          </Card>
        </SubSection>
      )}

      {instance.overrides && Object.keys(instance.overrides).length > 0 && (
        <SubSection title={t('overrides')} icon={<SlidersHorizontal className="size-4" />}>
          <Card>
            <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {JSON.stringify(instance.overrides, null, 2)}
            </pre>
          </Card>
          <p className="mt-2 text-[12px] text-muted-foreground">{t('overridesNote')}</p>
        </SubSection>
      )}
    </div>
  )
}
