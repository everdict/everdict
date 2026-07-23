// The infra split view hosts the REAL routed pages in same-origin iframes that stay mounted (frozen) once opened,
// so their in-iframe navigation and live streams survive tab switches (see widgets/infra-panel). Cookie-backed
// per-device preferences — locale and timezone — are resolved SERVER-SIDE at render time (next-intl reads the
// cookie in shared/i18n/request.ts), so an already-mounted iframe keeps the OLD value after the parent switches:
// router.refresh() re-renders only the parent's RSC tree, never the iframe's separate browsing context. The
// switchers broadcast this signal after the cookie is set; the infra panel reloads each mounted iframe in place
// (its current URL, re-requested with the new cookie). Theme is a client-only localStorage value that syncs live
// via the `storage` event (see app/layout.tsx), so it is deliberately NOT routed through here.
export const RELOAD_INFRA_FRAMES_EVENT = 'everdict:reload-infra-frames'

export function reloadInfraFrames(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(RELOAD_INFRA_FRAMES_EVENT))
}
