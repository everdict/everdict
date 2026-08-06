import { describe, expect, it } from 'vitest'

import { harnessListSpec, harnessTags } from './list-view'
import type { Harness } from './schema'

// 하네스의 이름표 = 버전 태그의 합집합. 목록이 "각각이 무엇인지"를 태그로 답하려면 어느 버전에 붙었든
// 라벨이 살아남아야 하고(합집합), 지금을 말하는 라벨이 앞서야 한다(최신 버전 우선).
function harnessOf(overrides: Partial<Harness>): Harness {
  return { id: 'h', owner: 'acme', versions: ['1.0.0', '1.1.0'], ...overrides }
}

describe('harnessTags', () => {
  it('returns the union of version tags, latest version first, deduplicated', () => {
    const harness = harnessOf({
      versionTags: { '1.0.0': ['baseline', 'codex'], '1.1.0': ['prod-candidate', 'codex'] },
    })
    expect(harnessTags(harness)).toEqual(['prod-candidate', 'codex', 'baseline'])
  })

  it('returns an empty list when no version carries a tag', () => {
    expect(harnessTags(harnessOf({}))).toEqual([])
    expect(harnessTags(harnessOf({ versionTags: {} }))).toEqual([])
  })

  it('ignores tags recorded for versions no longer in the live list', () => {
    const harness = harnessOf({ versionTags: { '0.9.0': ['retired'], '1.1.0': ['live'] } })
    expect(harnessTags(harness)).toEqual(['live'])
  })
})

describe('harnessListSpec tag axis', () => {
  it('offers the tag union as facet values', () => {
    const harness = harnessOf({ versionTags: { '1.1.0': ['web-agent'] } })
    expect(harnessListSpec.facetValues(harness, 'tag')).toEqual(['web-agent'])
    expect(harnessListSpec.facetValues(harnessOf({}), 'tag')).toEqual([])
  })

  it('finds a harness by one of its version tags in search text', () => {
    const harness = harnessOf({ versionTags: { '1.0.0': ['web-agent'] } })
    expect(harnessListSpec.searchText(harness)).toContain('web-agent')
  })
})
