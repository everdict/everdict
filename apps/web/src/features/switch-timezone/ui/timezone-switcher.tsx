'use client'

import { useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTimeZone, useTranslations } from 'next-intl'

import { DEFAULT_TIMEZONE, detectTimeZone, listTimeZones } from '@/shared/i18n/timezone'
import { reloadInfraFrames } from '@/shared/lib/reload-infra-frames'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'

import { setTimezone } from '../api/set-timezone'

// Current UTC offset label for a zone (e.g. "UTC+09:00") — the secondary hint that makes the raw IANA id readable.
function offsetLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    const name = parts.find((p) => p.type === 'timeZoneName')?.value
    if (!name) return ''
    // Normalize "GMT+9" → "UTC+09:00"; "GMT" → "UTC+00:00".
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
    if (!m) return name.replace('GMT', 'UTC')
    const [, sign, h, min] = m
    return `UTC${sign}${h.padStart(2, '0')}:${min ?? '00'}`
  } catch {
    return ''
  }
}

// Timezone picker — the canonical searchable combobox over every IANA zone this runtime supports. The chosen zone
// is stored in a cookie and applied immediately (down to server-rendered dates) via router.refresh. Sits in
// Preferences beside theme + language; all three are per-device preferences.
export function TimezoneSwitcher() {
  const t = useTranslations('timezone')
  const current = useTimeZone()
  const router = useRouter()
  const [, startTransition] = useTransition()

  const options = useMemo<ComboboxOption[]>(() => {
    return listTimeZones().map((tz) => {
      const off = offsetLabel(tz)
      return {
        value: tz,
        label: tz.replace(/_/g, ' '),
        hint: off,
        keywords: `${tz.replace(/[/_]/g, ' ')} ${off}`,
      }
    })
  }, [])

  function choose(next: string) {
    startTransition(async () => {
      await setTimezone(next)
      router.refresh()
      // Re-render the infra panel's mounted iframes too — they resolve the timezone server-side off the cookie
      // and router.refresh() does not reach their separate browsing context.
      reloadInfraFrames()
    })
  }

  return (
    <div className="flex items-center gap-2">
      <Combobox
        options={options}
        value={current ?? DEFAULT_TIMEZONE}
        onChange={choose}
        searchable
        align="end"
        className="min-w-[220px]"
        aria-label={t('label')}
        searchPlaceholder={t('searchPlaceholder')}
        emptyText={t('empty')}
      />
      <button
        type="button"
        onClick={() => choose(detectTimeZone())}
        className="whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {t('useBrowser')}
      </button>
    </div>
  )
}
