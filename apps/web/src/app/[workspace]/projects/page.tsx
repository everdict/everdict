import { ProjectListView } from '@/widgets/project-list'

export const dynamic = 'force-dynamic'

// 워크스페이스 전체의 프로젝트 — 워크스페이스가 유일한 경계이므로 주소도 하나다.
export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ status?: string; initiative?: string }>
}) {
  const { workspace } = await params
  const search = await searchParams
  return <ProjectListView workspace={workspace} filters={search} />
}
