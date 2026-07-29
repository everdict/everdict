export { reindexKnowledgeAction, type ReindexKnowledgeResult } from './api/reindex-knowledge'
export { KnowledgeExplorer } from './ui/knowledge-explorer'
// The map's presentation vocabulary (node colour by axis, predicate/type labels, relationship ranking) — shared with
// the split-view panel that renders a picked node's detail, so both halves speak the same visual language.
export { humanize, nodeColor, predicateRank } from './lib/node-style'
