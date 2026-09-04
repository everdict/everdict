import { describe, expect, it, vi } from 'vitest'

const calls: { method: string; args: unknown[] }[] = []
vi.mock('@/shared/auth/principal', () => ({ authContext: async () => ({ devTenant: 'acme' }) }))
vi.mock('@/shared/lib/control-plane', () => ({
  controlPlane: {
    annotateKnowledge: async (_c: unknown, body: unknown) => {
      calls.push({ method: 'annotate', args: [body] })
      return {}
    },
    knowledgeAnnotations: async () => {
      throw new Error('ledger down')
    },
    knowledgeRelated: async () => ({ related: [{ predicate: 'uses', nodeId: 'dataset:acme:swe' }] }),
  },
}))

const { annotateNodeAction, loadNodeFacts } = await import('./annotate-knowledge')

// The web could DRAW the knowledge graph and author nothing in it. Census slice 5 gave it the write side.
// docs/architecture/web-runtime-gap-census-spec.md
describe('knowledge contributions', () => {
  it('never sends an author — attribution is the control plane\'s stamp', async () => {
    // A note whose author the client could choose is not attribution. The route stamps the caller, and this
    // sends only the node and the text.
    await annotateNodeAction('harness:acme:web@1.0.0', 'the retries mask a real timeout')
    expect(calls.at(-1)?.args[0]).toEqual({
      node: 'harness:acme:web@1.0.0',
      note: 'the retries mask a real timeout',
    })
  })

  it('carries a failed read as an ERROR while still returning what the other read answered', async () => {
    // Two reads feed one panel. Collapsing them would let one outage hide the other's answer, and an empty
    // annotation list would tell a reader nothing is known about a node that may be richly annotated.
    const facts = await loadNodeFacts('harness:acme:web@1.0.0')
    expect(facts.error).toMatch(/ledger down/)
    expect(facts.annotations).toEqual([])
    expect(facts.related).toHaveLength(1)
  })
})
