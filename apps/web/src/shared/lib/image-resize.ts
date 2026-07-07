// Resize·compress an uploaded image to a square whose longest side is max (default 256px) and produce a JPEG data URL.
// A transparent background is filled with white to avoid it turning black. Shared by the profile avatar·workspace logo, with no separate storage.
// The control plane stores the data:image base64 (≤~1MB) as-is, so a small data URL fits safely.
// locale is passed by the caller (default ko) — the thrown message surfaces on screen via err.message.
export async function fileToImageDataUrl(
  file: File,
  max = 256,
  locale: string = 'ko'
): Promise<string> {
  const ko = locale.startsWith('ko')
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () =>
        reject(new Error(ko ? '이미지를 불러올 수 없습니다.' : 'Could not load the image.'))
      el.src = objectUrl
    })
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const cx = canvas.getContext('2d')
    if (!cx) throw new Error(ko ? '이미지 처리에 실패했습니다.' : 'Image processing failed.')
    cx.fillStyle = '#ffffff'
    cx.fillRect(0, 0, w, h)
    cx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

// Allowed limit for the raw upload (avoids the decode burden before processing). After processing it shrinks to max px and gets much smaller.
export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024
