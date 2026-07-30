'use client'

import { useEffect, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { harnessesSchema, type Harness } from '@/entities/harness'
import { versionOptions } from '@/shared/lib/version-options'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

export interface BootInput {
  harnessId: string
  version: string
  image?: string
  ttlSec: number
}

const TTL_SECONDS = [900, 1800, 3600, 7200] as const

// The panel's empty state: pick a registered harness and boot it into a warm session. The version list rides on
// the harness list entry (no second request). The image override exists because a `process`-kind spec declares no
// container image of its own — the control plane answers 400 asking for one, and this is where the member gives it.
export function BootForm({
  canSubmit,
  booting,
  error,
  prefill,
  onBoot,
}: {
  canSubmit: boolean
  booting: boolean
  error?: string
  prefill?: { harnessId: string; version?: string }
  onBoot: (input: BootInput) => void
}) {
  const t = useTranslations('playground')
  const [harnesses, setHarnesses] = useState<Harness[]>([])
  const [harnessId, setHarnessId] = useState(prefill?.harnessId ?? '')
  const [version, setVersion] = useState(prefill?.version ?? 'latest')
  const [image, setImage] = useState('')
  const [ttlSec, setTtlSec] = useState<number>(1800)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/harnesses', { cache: 'no-store' })
        if (!res.ok) return
        const parsed = harnessesSchema.safeParse(await res.json())
        if (cancelled || !parsed.success) return
        setHarnesses(parsed.data)
        // Land on something bootable when nothing was pre-picked — the member still reviews before pressing boot.
        setHarnessId((current) => (current.length > 0 ? current : (parsed.data[0]?.id ?? '')))
      } catch {
        // Silent — the picker shows its empty text and the member can retry by reopening the tab.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const entry = harnesses.find((h) => h.id === harnessId)

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-col items-center gap-2 pb-1 text-center">
        <div className="grid size-9 place-items-center rounded-lg bg-elevated text-muted-foreground/70">
          <FlaskConical className="size-[18px]" strokeWidth={1.75} />
        </div>
        <p className="text-[13px] font-[510] text-foreground">{t('emptyTitle')}</p>
        <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
          {t('emptyBody')}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="playground-harness">{t('harnessLabel')}</Label>
        <Combobox
          id="playground-harness"
          options={harnesses.map((h) => ({ value: h.id }))}
          value={harnessId}
          onChange={(next) => {
            setHarnessId(next)
            setVersion('latest') // the prior version may not exist on the newly picked harness
          }}
          placeholder={t('harnessPlaceholder')}
          emptyText={t('harnessEmpty')}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="playground-version">{t('versionLabel')}</Label>
        <Combobox
          id="playground-version"
          options={versionOptions(entry?.versions ?? [], entry?.versionTags)}
          value={version}
          onChange={setVersion}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="playground-ttl">{t('ttlLabel')}</Label>
        <Combobox
          id="playground-ttl"
          options={TTL_SECONDS.map((seconds) => ({
            value: String(seconds),
            label: t(`ttl_${seconds}`),
          }))}
          value={String(ttlSec)}
          onChange={(next) => setTtlSec(Number.parseInt(next, 10))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="playground-image">{t('imageOverrideLabel')}</Label>
        <Input
          id="playground-image"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="ghcr.io/org/image:tag"
          className="font-mono text-[12px]"
        />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          {t('imageOverrideHint')}
        </p>
      </div>

      {error !== undefined && <Callout tone="danger">{error}</Callout>}
      {!canSubmit && <Callout tone="muted">{t('noSubmitRole')}</Callout>}

      <Button
        className="w-full"
        disabled={!canSubmit || booting || harnessId.length === 0}
        onClick={() =>
          onBoot({
            harnessId,
            version,
            ...(image.trim().length > 0 ? { image: image.trim() } : {}),
            ttlSec,
          })
        }
      >
        {booting ? t('booting') : t('boot')}
      </Button>
    </div>
  )
}
