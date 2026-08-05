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
      // 지식 엔트리 — normalize 가 `title` 을 라벨로 집는다(엔트리엔 name 이 없음).
      return controlPlane.listKnowledgeEntries<Row[]>(ctx)
    case 'environment': {
      // 환경 = capability 스토어의 environment kind — 하나의 스토어 목록에서 그 kind 만 추린다.
      const capabilities = await controlPlane.listCapabilities<Row[]>(ctx)
      return (Array.isArray(capabilities) ? capabilities : []).filter((c) => {
        const spec = (c as Row).spec
        return spec !== null && typeof spec === 'object' && (spec as Row).type === 'environment'
      })
    }
    case 'tool': {
      // 도구 = capability 스토어의 mcp|code kind — 환경과 같은 목록에서 그 두 kind 만 추린다.
      const capabilities = await controlPlane.listCapabilities<Row[]>(ctx)
      return (Array.isArray(capabilities) ? capabilities : []).filter((c) => {
        const spec = (c as Row).spec
        if (spec === null || typeof spec !== 'object') return false
        const kind = (spec as Row).type
        return kind === 'mcp' || kind === 'code'
      })
    }
    case 'issue':
      // 평가 트래커의 이슈 — normalize 가 `title` 을 라벨로 집는다(이슈엔 name 이 없음).
      // 열려 있는 것부터 보이도록 최근 활동순 슬라이스만 가져온다(닫힌 이슈까지 @-피커에 쏟지 않는다).
      // 목록은 한 PAGE(`{ items, nextCursor? }`)로 오고, @-피커는 첫 장이면 충분하다.
      // 참조 키는 UUID 가 아니라 식별자(ENG-12) — get_issue 가 둘 다 받고, 이슈를 부르는 이름은 식별자다.
      // 이슈 상세의 "대화에서 분석" 진입도 같은 키를 쓰므로 두 경로가 같은 참조를 만든다.
      // 검색은 제어 평면이 한다(`search`) — 창 하나를 받아 아래에서 거르면 워크스페이스가 그 창보다
      // 커지는 순간 조용히 못 찾기 시작한다(이슈만 서버 검색이 있다; 나머지는 아래의 클라이언트 여과).
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
    if (q)
      items = items.filter(
        (it) => it.id.toLowerCase().includes(q) || it.label.toLowerCase().includes(q)
      )
    return NextResponse.json({ items: items.slice(0, 20) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
