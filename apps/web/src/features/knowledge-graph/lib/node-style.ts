// Presentation maps for the knowledge graph. The node-type and predicate vocabularies are closed and live in
// @everdict/contracts as VALUE arrays the web may not import (type-only rule), so these mirror them as string-keyed
// lookups with a fallback — an unmapped (newly added) type/predicate degrades gracefully instead of crashing.

// The render axes from the node vocabulary (docs/architecture/knowledge-graph.md §node vocabulary). `claim` is the
// KNOWLEDGE LAYER — the reified claims and skills; `intent` is the TRACKER stratum (the issue hub the resource
// strata hang off); the rest is the entity stratum they are about.
type NodeAxis =
  | 'claim'
  | 'intent'
  | 'actor'
  | 'subject'
  | 'infra'
  | 'outcome'
  | 'analysis'
  | 'comms'
  | 'integration'

const AXIS_OF: Record<string, NodeAxis> = {
  knowledge: 'claim',
  skill: 'claim',
  issue: 'intent',
  project: 'intent',
  initiative: 'intent',
  // team/cycle are organisational scoping around the intent stratum — quiet, like the other actors.
  team: 'actor',
  cycle: 'actor',
  workspace: 'actor',
  user: 'actor',
  harness: 'subject',
  dataset: 'subject',
  case: 'subject',
  judge: 'subject',
  rubric: 'subject',
  model: 'subject',
  agent: 'subject',
  capability: 'subject',
  runtime: 'infra',
  runner: 'infra',
  image: 'infra',
  run: 'outcome',
  scorecard: 'outcome',
  schedule: 'outcome',
  tag: 'analysis',
  metric: 'analysis',
  view: 'analysis',
  comment: 'comms',
  agent_session: 'comms',
  repository: 'integration',
  trace_source: 'integration',
  secret: 'integration',
  browser_profile: 'integration',
}

// Categorical hues chosen to read on BOTH the light and near-black dark surfaces (mid-saturation, no theme token —
// these are data colors, not UI chrome). The eval subjects get the brand indigo (they are the graph's centre of mass);
// claims get the loudest hue and actors the quietest, since a workspace/user node is scoping chrome, not content.
const AXIS_COLOR: Record<NodeAxis, string> = {
  claim: '#8b5cf6', // violet — the knowledge layer
  intent: '#f97316', // orange — the issue hub (why we evaluate)
  actor: '#64748b', // slate
  subject: '#5e6ad2', // indigo (brand)
  infra: '#0ea5e9', // sky
  outcome: '#22c55e', // green
  analysis: '#f59e0b', // amber
  comms: '#ec4899', // pink
  integration: '#14b8a6', // teal
}

const FALLBACK_COLOR = '#94a3b8' // slate — an unmapped node type

export function nodeColor(type: string): string {
  const axis = AXIS_OF[type]
  return axis ? AXIS_COLOR[axis] : FALLBACK_COLOR
}

// A predicate/type identifier → readable label ("uses_dataset" → "uses dataset").
export function humanize(id: string): string {
  return id.replace(/_/g, ' ')
}

// Display priority for a node's relationships (mirrors @everdict/domain PREDICATE_PRIORITY — the eval story first,
// scoping edges last). Kept as a local copy because the web may not import the domain value. Lower = higher priority.
const PREDICATE_PRIORITY: readonly string[] = [
  'resolved_by',
  'verified_by',
  'born_from',
  'evaluates',
  'uses_dataset',
  'applies_judge',
  'measures',
  'compared_to',
  'supersedes',
  'derived_from',
  'fired_by',
  'runs_on',
  'placed_on',
  'child_of',
  'uses_model',
  'uses_rubric',
  'adopts',
  'uses_secret',
  'uses_browser_profile',
  'pins_image',
  'runs_image',
  'triggers',
  'connects_repo',
  'exports_to',
  'pulls_from',
  'about',
  'evidenced_by',
  'references',
  'discusses',
  'reply_to',
  'mentions',
  'tagged_with',
  'includes_case',
  'covers_case',
  'part_of',
  'assigned_to',
  'belongs_to',
  'succeeds',
  'created_by',
  'member_of',
  'in_workspace',
]

const PREDICATE_RANK = new Map<string, number>(PREDICATE_PRIORITY.map((p, i) => [p, i]))

export function predicateRank(predicate: string): number {
  return PREDICATE_RANK.get(predicate) ?? PREDICATE_PRIORITY.length
}
