// 업로드 이미지를 정사각 한 변 max(기본 256px)로 리사이즈·압축해 JPEG data URL 로 만든다.
// 투명 배경은 흰색으로 깔아 검게 뜨는 것을 막는다. 별도 스토리지 없이 프로필 아바타·워크스페이스 로고가 공유.
// 컨트롤플레인이 data:image base64(≤~1MB)를 그대로 저장하므로 작은 data URL 이 안전하게 담긴다.
// locale 은 호출부가 넘긴다(기본 ko) — 던져진 메시지가 err.message 로 화면에 노출됨.
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

// 원본 업로드 허용 한도(처리 전 디코딩 부담 방지). 처리 후엔 max px 로 줄어 훨씬 작아진다.
export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024
