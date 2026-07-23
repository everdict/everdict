import { NextResponse } from 'next/server'

import { AGENT_REFERENCE_TYPES, type AgentReferenceType } from '@/entities/agent-session'
import { authContext } from '@/shared/auth/principal'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

// Mention-picker search: browse the workspace's entities of one type as {id,label,version?} candidates for an
// @-reference. Reuses the control-plane list endpoints; normalizes their heterogeneous rows defensively.

type Row = Record<string, unknown>
interface MentionItem {
  id: string
  label: string
  version?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

async function fetchRows(ctx: AuthContext, type: AgentReferenceType): Promise<unknown> {
  switch (type) {
    case 'harness':
      return controlPlane.listHarnesses<Row[]>(ctx)
    case 'runtime':
      return controlPlane.listRuntimes<Row[]>(ctx)
    case 'dataset':
      return controlPlane.listDatasets<Row[]>(ctx)
    case 'judge':
      return controlPlane.listJudges<Row[]>(ctx)
    case 'view':
      return controlPlane.listViews<Row[]>(ctx)
    case 'scorecard':
      return controlPlane.listScorecards<Row[]>(ctx)
    case 'run':
      return controlPlane.listRuns<Row[]>(ctx, { limit: 30 })
  }
}

function normalize(row: unknown): MentionItem | null {
  if (row === null || typeof row !== 'object') return null
  const r = row as Row
  const id = str(r.id)
  if (!id) return null
  const versions = r.versions
  const version =
    str(r.latestVersion) ??
    (Array.isArray(versions) && typeof versions.at(-1) === 'string'
      ? (versions.at(-1) as string)
      : undefined)
  const label = str(r.name) ?? str(r.title) ?? str(r.label) ?? id
  return { id, label, ...(version ? { version } : {}) }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> }
): Promise<Response> {
  const { type } = await params
  if (!(AGENT_REFERENCE_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json({ items: [] })
  }
  const ctx = await authContext()
  const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase()
  try {
    const rows = await fetchRows(ctx, type as AgentReferenceType)
    let items = (Array.isArray(rows) ? rows : [])
      .map(normalize)
      .filter((x): x is MentionItem => x !== null)
    if (q)
      items = items.filter(
        (it) => it.id.toLowerCase().includes(q) || it.label.toLowerCase().includes(q)
      )
    return NextResponse.json({ items: items.slice(0, 20) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
