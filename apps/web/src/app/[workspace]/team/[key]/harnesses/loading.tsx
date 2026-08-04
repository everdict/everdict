import { ListPageSkeleton } from '@/shared/ui/skeleton'

// 팀 아래의 목록 화면 — 스코프 바가 한 줄 더 있으므로 팀 홈의 경계를 물려받지 않고 자기 것을 갖는다.
export default function TeamSectionLoading() {
  return <ListPageSkeleton scoped />
}
