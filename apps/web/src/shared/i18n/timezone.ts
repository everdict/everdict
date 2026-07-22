// Timezone constants — imported from both client (the switcher) and server (the request config), so no
// server-only (same pattern as the locale constants in ./config and the workspace-scope constants).
// Display timezone is a per-device preference (a cookie), a sibling of locale/theme — not stored server-side.

export const TIMEZONE_COOKIE = 'everdict-timezone'

// Pre-detection default: with no explicit choice yet, render in UTC. The client TimezoneAutoInit seeds the cookie
// from the browser's own zone on first visit, so a real user quickly lands on their local time; UTC is only the
// deterministic SSR default before that.
export const DEFAULT_TIMEZONE = 'UTC'

// A conservative fallback set for engines without Intl.supportedValuesOf. The live enumeration below is always
// preferred; this only keeps the picker usable if enumeration is unavailable.
const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

// Is this a valid IANA zone this runtime can format? (Intl throws RangeError on an unknown zone.)
export function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// The full IANA zone list this runtime supports (ES2023 Intl.supportedValuesOf), else the fallback set.
// Sorted alphabetically with UTC pinned first.
export function listTimeZones(): string[] {
  let zones: string[]
  try {
    zones =
      typeof Intl.supportedValuesOf === 'function'
        ? Intl.supportedValuesOf('timeZone')
        : FALLBACK_TIMEZONES
  } catch {
    zones = FALLBACK_TIMEZONES
  }
  const set = new Set(zones)
  set.add('UTC')
  return [...set].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)))
}

// The browser's own zone. Client-only: on the server Intl resolves to the host zone, so only call this in the browser.
export function detectTimeZone(): string {
  try {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE
  } catch {
    return DEFAULT_TIMEZONE
  }
}
