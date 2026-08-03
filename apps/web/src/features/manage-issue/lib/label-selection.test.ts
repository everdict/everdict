import { describe, expect, it } from 'vitest'

import type { IssueLabel } from '@/entities/issue-label'

import { toggleLabelId, withCreatedLabels } from './label-selection'

const label = (id: string, name: string): IssueLabel => ({
  id,
  tenant: 'acme',
  name,
  color: 'gray',
  createdBy: 'dana',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
})

describe('issue label selection', () => {
  it('adds a label the issue does not carry yet, keeping the order it was picked in', () => {
    expect(toggleLabelId(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('takes a label back off when it is already carried', () => {
    expect(toggleLabelId(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('shows a just-created label before the server has re-served the registry', () => {
    const merged = withCreatedLabels([label('l1', 'bug')], [label('l2', 'api')])

    expect(merged.map((l) => l.name)).toEqual(['api', 'bug'])
  })

  it('keeps the server registry as-is once it carries the created label (no duplicate row)', () => {
    const registry = [label('l1', 'bug'), label('l2', 'api')]

    expect(withCreatedLabels(registry, [label('l2', 'api')])).toBe(registry)
  })
})
