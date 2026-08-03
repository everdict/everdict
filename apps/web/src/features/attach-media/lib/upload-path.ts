// 붙여넣거나 끌어다 놓은 파일이 워크스페이스 파일시스템에서 살 자리.
//
// 따로 첨부 저장소를 만들지 않는 이유: 워크스페이스에는 이미 격리된 파일 트리가 있고(설정 › 파일에서 그대로
// 보이고, 에이전트도 같은 트리를 읽는다), 첨부만을 위한 두 번째 저장소는 같은 것을 두 곳에서 관리하게 만든다.
//
// 경로 조각은 제어 평면이 `[A-Za-z0-9._-]` 만 받는다(그 밖은 400). 그래서 이름은 여기서 접는다 — 한글 이름은
// 통째로 접혀 사라지므로, 사람이 읽을 이름은 본문에 삽입되는 대체 텍스트가 들고 경로는 확장자만 지킨다.
export const UPLOAD_ROOT = 'uploads'

const MAX_STEM = 60

export function safeFileName(name: string): string {
  // 브라우저가 준 이름에 경로가 섞여 오는 경우가 있다(디렉터리 드롭) — 마지막 조각만 쓴다.
  const base = name.split(/[\\/]/).at(-1) ?? ''
  const dot = base.lastIndexOf('.')
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const rawExt = dot > 0 ? base.slice(dot + 1) : ''

  const stem = rawStem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_STEM)
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '')
  const safeStem = stem === '' ? 'file' : stem
  return ext === '' ? safeStem : `${safeStem}.${ext}`
}

// 월별 폴더 + 충돌 방지용 짧은 식별자. 폴더를 나누는 것은 한 디렉터리가 수천 줄이 되면 설정 › 파일에서 사람이
// 훑을 수 없기 때문이다. 시각은 인자로 받는다 — 순수 함수라야 테스트가 시계를 흔들지 않는다.
export function uploadPathFor(name: string, id: string, at: Date): string {
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  return `${UPLOAD_ROOT}/${month}/${id}-${safeFileName(name)}`
}

// 업로드된 파일을 본문에서 가리키는 주소. 우리 라우트를 지나야 하는 이유는 오브젝트 스토리지의 주소가
// 서버 내부용이고 만료되기 때문이다(제어 평면은 바이트를 JSON 으로 준다). 경로 조각을 그대로 이어 붙여
// 주소가 실제 파일 이름으로 끝나게 한다 — 확장자로 매체를 판정하는 뷰어와 다운로드 이름이 그것에 기댄다.
export function uploadUrlFor(path: string): string {
  return `/api/fs/file/${path.split('/').map(encodeURIComponent).join('/')}`
}
