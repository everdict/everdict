import { describe, expect, it } from 'vitest'

import type { Project } from '@/entities/project'

import { projectCandidatesFor } from './project-candidates'

const project = (over: Partial<Project> & Pick<Project, 'id'>): Project =>
  ({
    tenant: 'acme',
    name: over.id,
    status: 'in_progress',
    initiativeIds: [],
    memberIds: [],
    history: [],
    createdBy: 'u',
    createdAt: 't',
    updatedAt: 't',
    ...over,
  }) as Project

describe('projectCandidatesFor — what a goal can still take in', () => {
  it('offers the projects that do not already name this goal', () => {
    const candidates = projectCandidatesFor('goal-1', [
      project({ id: 'already', initiativeIds: ['goal-1'] }),
      project({ id: 'elsewhere', initiativeIds: ['goal-2'] }), // one project serves several goals
      project({ id: 'loose' }),
    ])
    expect(candidates.map((p) => p.id)).toEqual(['elsewhere', 'loose'])
  })

  it('drops cancelled work — abandoned projects say nothing about reaching a goal', () => {
    const candidates = projectCandidatesFor('goal-1', [
      project({ id: 'dead', status: 'cancelled' }),
      project({ id: 'done', status: 'completed' }), // finished work DOES count toward a goal
    ])
    expect(candidates.map((p) => p.id)).toEqual(['done'])
  })

  it('offers nothing when every project is already in', () => {
    expect(
      projectCandidatesFor('goal-1', [project({ id: 'a', initiativeIds: ['goal-1'] })])
    ).toEqual([])
  })
})
