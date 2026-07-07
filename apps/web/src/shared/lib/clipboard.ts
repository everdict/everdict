import { toast } from 'sonner'

// 안전 컨텍스트(https·localhost)에선 navigator.clipboard, 그 외(http Tailscale IP 등)에선
// navigator.clipboard 가 undefined 라 legacy execCommand('copy') 로 폴백한다(그래서 http 접속에서도 동작).
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 안전 컨텍스트여도 권한 거부될 수 있음 — 아래 폴백으로.
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

// 텍스트 복사 + 토스트. 성공하면 sonner 토스트로 "복사했어요"를 띄우고(message 로 문구 변경, null=토스트 끔),
// 실패하면 오류 토스트. 성공 여부를 반환 — 호출부가 인라인 "복사됨" 상태도 함께 쓸 수 있다.
// message 미지정(undefined) = 로케일 기본 문구, null = 토스트 끔. locale 은 호출부가 넘긴다(기본 ko).
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
