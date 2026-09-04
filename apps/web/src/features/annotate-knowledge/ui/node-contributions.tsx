'use client'

import { useEffect, useState, useTransition } from 'react'
import { Eye, Link2, MessageSquarePlus, Network } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import {
  annotateNodeAction,
  loadNeighbourhood,
  loadNodeFacts,
  previewAgentContext,
  relateNodesAction,
  type AgentContextPreview,
  type NodeFacts,
  type NodeNeighbourhood,
} from '../api/annotate-knowledge'

// What is known about the selected node, and the two ways a person adds to it. Shown beside the graph
// rather than on a page of its own: the node you are looking at IS the context, and a second page would
// make the reader carry the id across.
export function NodeContributions({ nodeId, predicates }: { nodeId: string; predicates: string[] }) {
  const t = useTranslations('knowledgePage')
  const [facts, setFacts] = useState<NodeFacts>()
  const [note, setNote] = useState('')
  const [target, setTarget] = useState('')
  const [predicate, setPredicate] = useState(predicates[0] ?? '')
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()
  const [walk, setWalk] = useState<NodeNeighbourhood>()
  const [preview, setPreview] = useState<AgentContextPreview>()

  const reload = () => start(async () => setFacts(await loadNodeFacts(nodeId)))
  // Re-read whenever the selection moves — the panel is ABOUT the node, so keeping a previous node's notes
  // on screen would attribute them to this one.
  useEffect(reload, [nodeId])

  return (
    <div className="space-y-3">
      {facts?.error !== undefined && (
        // A read that failed is not "nothing is known". Rendering an empty list would tell a reader this
        // node has no notes when it may have many.
        <p className="text-[12px] text-destructive">{t('factsUnread', { error: facts.error })}</p>
      )}

      {facts !== undefined && facts.annotations.length > 0 && (
        <ul className="space-y-1">
          {facts.annotations.map((a, i) => (
            <li key={`${a.at ?? ''}-${i}`} className="text-[12px]">
              <span className="text-muted-foreground">{a.note}</span>
              {a.author !== undefined && <span className="ml-1.5 text-faint">— {a.author}</span>}
            </li>
          ))}
        </ul>
      )}
      {facts !== undefined && facts.related.length > 0 && (
        <ul className="space-y-0.5">
          {facts.related.map((r, i) => (
            <li key={`${r.predicate}-${r.nodeId}-${i}`} className="font-mono text-[11.5px] text-muted-foreground">
              {r.predicate} → {r.nodeId}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('notePlaceholder')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 text-[13px]"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || note.trim() === ''}
          onClick={() => {
            setError(undefined)
            start(async () => {
              const res = await annotateNodeAction(nodeId, note.trim())
              if (!res.ok) {
                setError(res.error ?? t('noteError'))
                return
              }
              setNote('')
              setFacts(await loadNodeFacts(nodeId))
            })
          }}
        >
          <MessageSquarePlus className="size-4" /> {t('addNote')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {/* The predicate list comes from the control plane's closed vocabulary — a free-text box here would
            let somebody assert an edge kind the graph has no rule for, and it would look saved. */}
        <select
          value={predicate}
          onChange={(e) => setPredicate(e.target.value)}
          className="h-8 rounded-md border border-border/60 bg-transparent px-2 text-[12.5px]"
        >
          {predicates.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={t('targetPlaceholder')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 font-mono text-[12.5px]"
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || target.trim() === '' || predicate === ''}
          onClick={() => {
            setError(undefined)
            start(async () => {
              const res = await relateNodesAction(nodeId, target.trim(), predicate)
              if (!res.ok) {
                setError(res.error ?? t('relateError'))
                return
              }
              setTarget('')
              setFacts(await loadNodeFacts(nodeId))
            })
          }}
        >
          <Link2 className="size-4" /> {t('relate')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {/* The map is capped for DRAWING. This is how a reader asks what is behind one node without
            re-rendering the whole graph. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => start(async () => setWalk(await loadNeighbourhood(nodeId, 2)))}
        >
          <Network className="size-4" /> {t('expand')}
        </Button>
        {/* …and what an AGENT would be handed for this anchor. "The agent has context about this" is a claim
            somebody has to be able to check before trusting a run that rested on it. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => start(async () => setPreview(await previewAgentContext([nodeId])))}
        >
          <Eye className="size-4" /> {t('previewContext')}
        </Button>
      </div>

      {walk !== undefined && (
        <ul className="space-y-0.5">
          {walk.hops.map((h, i) => (
            <li key={`${h.nodeId}-${i}`} className="font-mono text-[11.5px] text-muted-foreground">
              {'· '.repeat(h.depth ?? 1)}
              {h.predicate !== undefined ? `${h.predicate} → ` : ''}
              {h.nodeId}
            </li>
          ))}
          {walk.hops.length === 0 && <li className="text-[12px] text-faint">{t('noHops')}</li>}
        </ul>
      )}

      {preview !== undefined && (
        <div className="rounded-md border border-border/60 p-2">
          {preview.entries.length === 0 ? (
            // An agent handed NOTHING for this anchor is the finding, not an empty panel.
            <p className="text-[12px] text-muted-foreground">{t('contextEmpty')}</p>
          ) : (
            <ul className="space-y-1">
              {preview.entries.map((e, i) => (
                <li key={`${e.title ?? ''}-${i}`} className="text-[12px]">
                  <span className="font-[510]">{e.title ?? ''}</span>
                  {e.freshness !== undefined && <span className="ml-1.5 text-faint">({e.freshness})</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error !== undefined && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  )
}
