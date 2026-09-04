import { describe, expect, it } from 'vitest'

import { environmentListSchema } from './browse-environments'

// The environment REGISTRY — distinct from the adopted images beside it: an image is bytes, an environment
// is the world those bytes make, and only the second is an identity axis a batch can seal. It had no web
// surface at all. docs/architecture/web-runtime-gap-census-spec.md
describe('environmentListSchema', () => {
  it('keeps the versions and their tags', () => {
    const out = environmentListSchema.parse({
      environments: [{ id: 'ubuntu-base', versions: ['1.0.0', '1.1.0'], versionTags: { '1.1.0': ['stable'] } }],
    })
    expect(out.environments[0]?.versions).toEqual(['1.0.0', '1.1.0'])
    expect(out.environments[0]?.versionTags?.['1.1.0']).toEqual(['stable'])
  })

  it('defaults a missing version list to empty rather than undefined', () => {
    // The panel indexes `versions[length - 1]` for the latest; an undefined list there would crash the
    // settings page over an environment that simply has none yet.
    expect(environmentListSchema.parse({ environments: [{ id: 'x' }] }).environments[0]?.versions).toEqual([])
  })
})
