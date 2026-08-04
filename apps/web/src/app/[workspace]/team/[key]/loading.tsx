import { IssueListSkeleton } from '@/widgets/issue-list'

// 팀의 짧은 주소(`/{workspace}/teams/ENG`)는 그 팀의 이슈 목록이다 — 그래서 이 경계도 목록 모양이다.
// 이슈가 아닌 하위 세그먼트(사이클·프로젝트·스코어카드)는 자기 경계를 따로 갖는다: 물려받으면 사이클
// 화면을 여는 동안 이슈 목록의 자리표시자가 뜨고, 그건 다른 화면이 온다는 잘못된 약속이다.
export default function TeamHomeLoading() {
  return <IssueListSkeleton scoped />
}
