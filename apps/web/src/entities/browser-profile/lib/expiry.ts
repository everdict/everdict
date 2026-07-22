// Profile staleness (browser-profiles — "surface staleness + one-click re-login"). A saved profile's login is only
// as fresh as its soonest-expiring cookie (`expiresAt`, the earliest captured-cookie expiry the control plane
// computes at capture). We turn that into a status the Settings row renders prominently as the expiry nears, so an
// owner can re-login before an eval runs unauthenticated. `nowMs` is injected so this stays pure/testable.

export type ProfileExpiryStatus =
  | { kind: 'none' } // nothing captured yet — no expiry to show
  | { kind: 'session' } // captured, but only session cookies — no fixed wall-clock expiry
  | { kind: 'ok'; expiresAt: string; days: number } // comfortably in the future (days = until expiry)
  | { kind: 'soon'; expiresAt: string; days: number } // within the warning window (days = until expiry, ≥ 0)
  | { kind: 'expired'; expiresAt: string; days: number } // already lapsed (days = since expiry, ≥ 0)

// The profile counts as "expiring soon" this many days out from its earliest cookie expiry — the re-login nudge
// window. Chosen to give an owner a comfortable week to refresh before a scheduled/CI eval would run stale.
export const EXPIRY_SOON_DAYS = 7

const DAY_MS = 86_400_000

export function profileExpiryStatus(
  profile: { capturedAt: string | null; expiresAt: string | null },
  nowMs: number
): ProfileExpiryStatus {
  if (!profile.capturedAt) return { kind: 'none' } // no login captured yet
  if (!profile.expiresAt) return { kind: 'session' } // session-only cookies — no wall-clock expiry
  const expMs = new Date(profile.expiresAt).getTime()
  if (Number.isNaN(expMs)) return { kind: 'none' }
  if (expMs <= nowMs)
    return {
      kind: 'expired',
      expiresAt: profile.expiresAt,
      days: Math.floor((nowMs - expMs) / DAY_MS),
    }
  const days = Math.ceil((expMs - nowMs) / DAY_MS)
  if (days <= EXPIRY_SOON_DAYS) return { kind: 'soon', expiresAt: profile.expiresAt, days }
  return { kind: 'ok', expiresAt: profile.expiresAt, days }
}
