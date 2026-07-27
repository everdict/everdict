'use client'

import { useEffect } from 'react'

// Escape a same-origin iframe by sending the TOP window somewhere (e.g. re-login). Rendered INSTEAD of a
// redirect() when the request came from the infra panel's iframe — a plain redirect would trap the target
// page inside the panel (the sign-in flow must never render there: Keycloak refuses framing, and the Auth.js
// page ignores the app theme). Falls back to navigating this frame if the top window is cross-origin.
export function FrameEscape({ href }: { href: string }) {
  useEffect(() => {
    try {
      ;(window.top ?? window).location.replace(href)
    } catch {
      window.location.replace(href)
    }
  }, [href])
  return null
}
