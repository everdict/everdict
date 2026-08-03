import type { MarkdownImageProxy } from '@/shared/ui/markdown'

// 가져온 이슈의 본문·코멘트는 원격이 쓴 마크다운 그대로다 — 그 안의 이미지는 GitHub 주소이고, 그 주소는 리포와
// 똑같은 인증 뒤에 있다. GHE 는 전부(로그인 없이는 아무것도 안 준다), github.com 은 비공개 리포가 그렇다. 이
// 화면을 보는 브라우저에는 GitHub 세션이 없으니(크로스사이트 img 요청에는 쿠키가 안 실린다) 우리 라우트를 거쳐
// 서버가 대신 받아온다.
//
// 오리진 목록은 컨트롤플레인의 허용 규칙과 같은 것을 본다: GHE 사본이면 그 호스트 하나, github.com 사본이면
// github.com + 본문에 실제로 등장하는 사용자 콘텐츠 호스트들. 여기서 프록시로 보내지 않은 주소는 저쪽에서도
// 거절되므로, 두 목록이 어긋나면 이미지가 아니라 400 이 뜬다.
const GITHUB_COM_ORIGINS = [
  'https://github.com',
  'https://private-user-images.githubusercontent.com',
  'https://user-images.githubusercontent.com',
  'https://raw.githubusercontent.com',
  'https://objects.githubusercontent.com',
]

// 가져오지 않은(로컬에서 작성한) 이슈는 프록시할 대상이 없다 — undefined 를 주면 Markdown 은 원본 그대로 그린다.
export function issueAttachmentProxy(
  issueId: string,
  github?: { host?: string }
): MarkdownImageProxy | undefined {
  if (!github) return undefined
  const origins = github.host ? originOf(github.host) : GITHUB_COM_ORIGINS
  if (origins.length === 0) return undefined
  return { origins, path: `/api/issues/${encodeURIComponent(issueId)}/attachment` }
}

// 저장된 호스트는 "https://ghe.acme.io" 처럼 베이스 URL 이다. new URL(...).origin 으로 정규화해야 본문 이미지의
// 오리진과 문자열로 맞물린다(호스트 소문자화·기본 포트 생략·후행 슬래시 제거).
function originOf(host: string): string[] {
  const trimmed = host.replace(/\/+$/, '')
  try {
    return [new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).origin]
  } catch {
    return []
  }
}
