import { toast } from 'sonner'

// In a secure context (https·localhost) use navigator.clipboard; elsewhere (http Tailscale IP, etc.)
// navigator.clipboard is undefined, so fall back to legacy execCommand('copy') (so it works over http too).
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Even in a secure context permission may be denied — fall through to the fallback below.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Copy text + toast. On success, show a sonner "copied" success toast (message overrides the text, null = no toast);
// on failure, show an error toast. Returns whether it succeeded — the caller can also drive an inline "copied" state.
// message unset (undefined) = locale default text, null = no toast. locale is passed by the caller (default ko).
export async function copyText(
  text: string,
  message?: string | null,
  locale: string = 'ko'
): Promise<boolean> {
  const ok = await writeClipboard(text)
  const ko = locale.startsWith('ko')
  if (ok) {
    const resolved =
      message === undefined ? (ko ? '클립보드에 복사했어요' : 'Copied to clipboard') : message
    if (resolved !== null) toast.success(resolved)
  } else {
    toast.error(ko ? '복사하지 못했어요.' : 'Could not copy.')
  }
  return ok
}
