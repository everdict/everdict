import { ProjectListView } from '@/widgets/project-list'

export const dynamic = 'force-dynamic'

// Every project in the workspace — the workspace is the only boundary, so there is only one address.
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
