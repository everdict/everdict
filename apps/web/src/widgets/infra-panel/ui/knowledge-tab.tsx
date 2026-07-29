'use client'

import { useEffect, useMemo, useState } from 'react'
import { Network } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { humanize, nodeColor, predicateRank } from '@/features/knowledge-graph'
import {
  knowledgeEntrySchema,
  type KnowledgeEntry,
  type KnowledgeNodeView,
} from '@/entities/knowledge'
import { fmtDateTime, fmtSubject } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Markdown } from '@/shared/ui/markdown'

import { useInfraPanel } from '../model/infra-panel-context'

// The panel's knowledge tab — what the node picked on the map IS, and what sits around it. Identity, harvested
// attributes and relationships come from the published map (the same data the canvas draws); a claim additionally
// loads its own record, because the map carries only a label and the claim's payload is its body.

interface Fact {
  predicate: string
  direction: 'out' | 'in'
  node: KnowledgeNodeView
}

export function KnowledgeTab() {
  const t = useTranslations('knowledge')
  const { knowledgeGraph, knowledgeNodeId, openKnowledgeNode } = useInfraPanel()

  const nodeById = useMemo(
    () => new Map((knowledgeGraph?.nodes ?? []).map((n) => [n.nodeId, n])),
    [knowledgeGraph]
  )
  const node = knowledgeNodeId === null ? undefined : nodeById.get(knowledgeNodeId)

  const groups = useMemo(() => {
    if (!node || !knowledgeGraph) return []
    const facts: Fact[] = []
    for (const e of knowledgeGraph.edges) {
      if (e.subjectNodeId === undefined || e.objectNodeId === undefined) continue
      const isSubject = e.subjectNodeId === node.nodeId
      const isObject = e.objectNodeId === node.nodeId
      if (!isSubject && !isObject) continue
      // Only materialised endpoints — the workspace-scoping star is noise, not a relationship.
      const other = nodeById.get(isSubject ? e.objectNodeId : e.subjectNodeId)
      if (other === undefined) continue
      facts.push({ predicate: e.predicate, direction: isSubject ? 'out' : 'in', node: other })
    }
    const byGroup = new Map<string, Fact[]>()
    for (const fact of facts) {
      const key = `${fact.direction}:${fact.predicate}`
      const bucket = byGroup.get(key)
      if (bucket) bucket.push(fact)
      else byGroup.set(key, [fact])
    }
    return [...byGroup.entries()]
      .map(([key, items]) => ({
        key,
        predicate: items[0].predicate,
        direction: items[0].direction,
        items,
      }))
      .sort(
        (a, b) =>
          predicateRank(a.predicate) - predicateRank(b.predicate) ||
          a.direction.localeCompare(b.direction)
      )
  }, [node, knowledgeGraph, nodeById])

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState icon={<Network />} title={t('selectHint')} />
      </div>
    )
  }

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: nodeColor(node.type) }}
            aria-hidden
          />
          <Badge tone="outline">{humanize(node.type)}</Badge>
          {node.version !== undefined && (
            <span className="font-mono text-[11px] text-muted-foreground">@{node.version}</span>
          )}
          {node.resolution === 'dangling' && <Badge tone="warning">{t('pending')}</Badge>}
        </div>
        <h3 className="mt-1.5 break-words text-[15px] font-[560] tracking-[-0.01em]">
          {node.label}
        </h3>
        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground/70">{node.key}</p>
      </div>

      <NodeAttributes node={node} />

      {node.type === 'knowledge' && <ClaimBody entryId={node.key} />}

      {groups.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11px] font-[560] uppercase tracking-wide text-muted-foreground/80">
            {t('relationships')}
          </div>
          {groups.map((group) => (
            <div key={group.key} className="space-y-1">
              <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span aria-hidden>{group.direction === 'out' ? '→' : '←'}</span>
                {humanize(group.predicate)}
                <span className="tabular-nums text-muted-foreground/60">{group.items.length}</span>
              </div>
              <ul className="space-y-0.5">
                {group.items.map((fact) => (
                  <li key={`${group.key}:${fact.node.nodeId}`}>
                    <button
                      type="button"
                      onClick={() => openKnowledgeNode(fact.node.nodeId)}
                      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-accent"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: nodeColor(fact.node.type) }}
                        aria-hidden
                      />
                      <span className="truncate">{fact.node.label}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
                        {humanize(fact.node.type)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// The harvested display bag (kind/status/visibility/verifiedAt/…) plus the observation counts — a node's "what it is"
// without re-fetching its record. Empty sections stay hidden.
function NodeAttributes({ node }: { node: KnowledgeNodeView }) {
  const t = useTranslations('knowledge')
  const attrs = Object.entries(node.attrs).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  )
  const observed = node.lastObservedAt
  if (attrs.length === 0 && node.evidenceCount === 0 && observed === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
      {attrs.map(([key, value]) => (
        <span key={key}>
          <span className="text-muted-foreground/60">{humanize(key)} </span>
          {String(value)}
        </span>
      ))}
      {node.evidenceCount > 0 && <span>{t('evidence', { count: node.evidenceCount })}</span>}
      {observed !== undefined && <span>{fmtDateTime(observed)}</span>}
    </div>
  )
}

// A claim node's own record — the body is the point of a claim, and the map only carries its title.
function ClaimBody({ entryId }: { entryId: string }) {
  const t = useTranslations('knowledge')
  const [entry, setEntry] = useState<KnowledgeEntry | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setEntry(null)
    setFailed(false)
    void (async () => {
      try {
        const res = await fetch(`/api/knowledge/entries/${encodeURIComponent(entryId)}`, {
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(String(res.status))
        const parsed = knowledgeEntrySchema.safeParse(await res.json())
        if (!live) return
        if (parsed.success) setEntry(parsed.data)
        else setFailed(true)
      } catch {
        if (live) setFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [entryId])

  if (failed || entry === null) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
        <Badge tone={entry.status === 'active' ? 'info' : 'outline'}>
          {t(`kinds.${entry.kind}`)}
        </Badge>
        {entry.status !== 'active' && <Badge tone="outline">{t(`statuses.${entry.status}`)}</Badge>}
        <span>
          {t('detail.meta', {
            by: fmtSubject(entry.createdBy),
            updated: fmtDateTime(entry.updatedAt),
          })}
        </span>
      </div>
      {entry.coverage !== undefined && entry.coverage.state !== 'current' && (
        <Callout tone="warning">{t(`coverage.${entry.coverage.state}`)}</Callout>
      )}
      {entry.body.trim() !== '' && <Markdown content={entry.body} className="text-[13px]" />}
    </div>
  )
}
