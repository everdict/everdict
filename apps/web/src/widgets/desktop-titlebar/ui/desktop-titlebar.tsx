'use client'

import { useEffect, useState } from 'react'
import { Minus, Square, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { getEverdictDesktop, type DesktopWindowControls } from '@/shared/lib/desktop-bridge'
import { cn } from '@/shared/lib/utils'

// The custom, theme-aware window title bar — shown ONLY inside the Electron desktop shell when the OS window is
// frameless (the bridge exposes `window`, desktop D10). In a browser — or on an older desktop with a native frame —
// it renders nothing (zero impact on web users). It owns the drag region and, on Windows/Linux, the minimize/maximize/
// close buttons; macOS keeps its native traffic lights, so we only reserve the left gutter for them. All styling uses the
// app's own theme tokens (bg-background/border/muted-foreground/…) so it matches light + dark automatically.
export function DesktopTitlebar() {
  const t = useTranslations('titleBar')
  const [controls, setControls] = useState<DesktopWindowControls | null>(null)
  const [isMac, setIsMac] = useState(false)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // The frameless OS title bar belongs to the real top window. getEverdictDesktop now resolves the bridge
    // across the frame boundary (so embedded panel pages detect the shell), so an embedded document could also
    // see `window` controls — but it must never draw a second title bar inside the infra panel's iframe.
    if (window.top !== window.self) return
    const bridge = getEverdictDesktop()
    const win = bridge?.window
    if (!bridge || !win) return
    // Mark the root so globals.css offsets the app content below the fixed bar (and shrinks full-height shells).
    document.documentElement.classList.add('desktop-shell')
    setControls(win)
    void bridge
      .appInfo()
      .then((info) => setIsMac(info.platform === 'darwin'))
      .catch(() => {})
    void win
      .isMaximized()
      .then(setMaximized)
      .catch(() => {})
    const unsubscribe = win.onMaximizeChange(setMaximized)
    return () => {
      document.documentElement.classList.remove('desktop-shell')
      unsubscribe()
    }
  }, [])

  if (!controls) return null

  return (
    <header className="titlebar-drag fixed inset-x-0 top-0 z-[120] flex h-9 select-none items-center justify-between border-b border-border bg-background/80 backdrop-blur-xl">
      {/* Left — reserve the macOS traffic-light gutter (else a slim left inset), then a small brand mark. */}
      <div className={cn('flex items-center gap-2 pr-3.5', isMac ? 'pl-[70px]' : 'pl-3.5')}>
        <span className="size-2 rounded-full bg-primary" aria-hidden />
        <span className="text-[12px] font-[560] text-muted-foreground">Everdict</span>
      </div>

      {/* Right — window controls (Windows/Linux only; macOS uses its native traffic lights). */}
      {!isMac && (
        <div className="titlebar-no-drag flex h-full">
          <button
            type="button"
            aria-label={t('minimize')}
            onClick={() => void controls.minimize()}
            className="inline-flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Minus className="size-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={maximized ? t('restore') : t('maximize')}
            onClick={() => void controls.toggleMaximize()}
            className="inline-flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {maximized ? <RestoreGlyph /> : <Square className="size-3" strokeWidth={2} />}
          </button>
          <button
            type="button"
            aria-label={t('close')}
            onClick={() => void controls.close()}
            className="inline-flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-white"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      )}
    </header>
  )
}

// Restore glyph (two offset squares) — lucide has no dedicated "restore", so a small inline SVG matched to the stroke weight.
function RestoreGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.4" y="3.6" width="6" height="6" rx="1" />
      <path d="M4.6 3.6V2.4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H9.4" />
    </svg>
  )
}
