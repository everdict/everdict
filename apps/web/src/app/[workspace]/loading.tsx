import { ListPageSkeleton } from '@/shared/ui/skeleton'

// 워크스페이스 아래 모든 화면의 기본 로딩 경계.
//
// 이 파일이 없던 동안 모든 이동이 **전면 블로킹**이었다: 필터 칩을 누르면 서버 렌더가 끝날 때까지 이전 화면이
// 그대로 얼어붙어 있었고, 눌렸는지 아닌지를 말해 주는 것이 아무것도 없었다. 더 조용한 손해도 있었다 —
// Next.js 는 동적 라우트를 **로딩 경계까지만** 프리페치하므로, 경계가 없으면 `<Link>` 프리페치가 통째로
// 무의미했다(모든 페이지가 `force-dynamic`이다). 경계 하나가 그 둘을 동시에 되돌린다.
//
// 더 구체적인 모양이 필요한 화면은 자기 세그먼트에 `loading.tsx` 를 두어 이 기본형을 덮는다(이슈 목록).
export default function WorkspaceLoading() {
  return <ListPageSkeleton />
}
