import { describe, expect, it } from 'vitest'

import { parseDelegationEntry } from './transcript'

// The card can only attach to a delegation whose SESSION RUN ID it knows, and that id lives only in the tool
// RESULT (the create_sandbox response is the sandbox RunRecord). These are the four states the transcript can
// legitimately be in — the parser must never throw on any of them.
const call = (args: unknown) => ({
  id: 'call-1',
  name: 'create_sandbox',
  arguments: JSON.stringify(args),
})

describe('parseDelegationEntry — a delegation the agent made, read back off the transcript', () => {
  it('reads the profile and the goal from the call, and the session id from the result', () => {
    const view = parseDelegationEntry(
      call({ profile: { id: 'fixer' }, brief: { goal: 'make the regressed cases pass' } }),
      JSON.stringify({ id: 'run-9', kind: 'sandbox', session: { conversation: true } })
    )
    expect(view).toMatchObject({
      profileId: 'fixer',
      goal: 'make the regressed cases pass',
      sessionRunId: 'run-9',
      status: 'open',
    })
  })

  it('is RUNNING while the tool has not answered yet — the card shows a spinner, not an empty conversation', () => {
    const view = parseDelegationEntry(
      call({ profile: { id: 'fixer' }, brief: { goal: 'fix it' } }),
      undefined
    )
    expect(view).toMatchObject({ status: 'running' })
    expect(view?.sessionRunId).toBeUndefined()
  })

  it('is FAILED when the result is not a run record — a permission denial is a result, not a crash', () => {
    // In the chat's default/plan permission mode the gate answers before the control plane does.
    const view = parseDelegationEntry(
      call({ profile: { id: 'fixer' }, brief: { goal: 'fix it' } }),
      'create_sandbox: the member declined this action'
    )
    expect(view).toMatchObject({ status: 'failed' })
    expect(view?.detail).toContain('declined')
  })

  it('is NOT a delegation without a profile — a plain sandbox boot draws no card', () => {
    expect(
      parseDelegationEntry(call({ image: 'python:3.12-slim' }), '{"id":"run-1"}')
    ).toBeUndefined()
    expect(
      parseDelegationEntry({ id: 'c', name: 'create_sandbox', arguments: 'not json' }, undefined)
    ).toBeUndefined()
  })
})
