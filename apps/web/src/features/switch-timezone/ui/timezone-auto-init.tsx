'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

import { detectTimeZone, TIMEZONE_COOKIE } from '@/shared/i18n/timezone'

import { setTimezone } from '../api/set-timezone'

// First-visit default: if the user has never chosen a zone (no cookie), seed it from the browser's own zone so
// timestamps render in the viewer's local time instead of the UTC/server default. Runs once; the explicit picker
// in Preferences overrides it thereafter. Renders nothing.
export function TimezoneAutoInit() {
  const router = useRouter()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    const hasCookie = document.cookie.split('; ').some((c) => c.startsWith(`${TIMEZONE_COOKIE}=`))
    if (hasCookie) return
    const tz = detectTimeZone()
    if (tz === 'UTC') return // nothing to correct — the SSR default already matches
    void setTimezone(tz).then(() => router.refresh())
  }, [router])
  return null
}
