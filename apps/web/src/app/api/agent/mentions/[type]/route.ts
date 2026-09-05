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

async function fetchRows(ctx: AuthContext, type: AgentReferenceType, q: string): Promise<unknown> {
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
    case 'skill':
      return controlPlane.listSkills<Row[]>(ctx)
    case 'knowledge':
      // A knowledge entry — normalize picks `title` as the label (an entry has no name).
      return controlPlane.listKnowledgeEntries<Row[]>(ctx)
    case 'environment': {
      // An environment = the capability store's environment kind — that kind alone is filtered out of the one store list.
      const capabilities = await controlPlane.listCapabilities<Row[]>(ctx)
      return (Array.isArray(capabilities) ? capabilities : []).filter((c) => {
        const spec = (c as Row).spec
        return spec !== null && typeof spec === 'object' && (spec as Row).type === 'environment'
      })
    }
    case 'tool': {
      // A tool = the capability store's mcp|code kinds — those two are filtered out of the same list as environments.
      const capabilities = await controlPlane.listCapabilities<Row[]>(ctx)
      return (Array.isArray(capabilities) ? capabilities : []).filter((c) => {
        const spec = (c as Row).spec
        if (spec === null || typeof spec !== 'object') return false
        const kind = (spec as Row).type
        return kind === 'mcp' || kind === 'code'
      })
    }
    case 'issue':
      // An eval tracker issue — normalize picks `title` as the label (an issue has no name).
      // Only a recent-activity slice is fetched so that OPEN ones surface first (closed issues are not poured into the @-picker).
      // The list arrives as one PAGE (`{ items, nextCursor? }`), and the first is enough for an @-picker.
      // The reference key is the identifier (ENG-12) rather than the UUID — get_issue accepts both, and the identifier is what an issue is CALLED.
      // The issue detail's "analyze in conversation" entry uses the same key, so both paths build the same reference.
      // The SEARCH is the control plane's (`search`) — taking one page and filtering below starts silently failing to find things the moment
      // the workspace outgrows that page (only issues have a server search; the rest are filtered client-side below).
      return controlPlane
        .listIssues<{ items: Row[] }>(ctx, { ...(q ? { search: q } : {}), limit: 50 })
        .then((page) =>
          (Array.isArray(page.items) ? page.items : []).map((row) => ({
            ...row,
            id: str(row.identifier) ?? row.id,
          }))
        )
    case 'trace':
      // trace references are attached from the observability browser (keyed by source+traceId), not @-picked here.
      return []
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
    const rows = await fetchRows(ctx, type as AgentReferenceType, q)
    let items = (Array.isArray(rows) ? rows : [])
      .map(normalize)
      .filter((x): x is MentionItem => x !== null)
    // Issues are already the control plane's searched-and-narrowed answer (fetchRows passes `search`) — filtering by substring once more here
    // would silently drop rows found by SERVER semantics (a match outside the identifier and title). Only the other types, which fetch a whole
    // page, are filtered here.
    if (q && type !== 'issue')
      items = items.filter(
        (it) => it.id.toLowerCase().includes(q) || it.label.toLowerCase().includes(q)
      )
    return NextResponse.json({ items: items.slice(0, 20) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
