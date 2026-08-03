import { describe, expect, it } from 'vitest'

import { displayImageRef, imageRepositoryOf } from './image-ref'

const DIGEST = `sha256:${'a1b2c3d4'.repeat(8)}`

describe('displayImageRef — a pinned ref has to stay readable', () => {
  it('keeps repository and tag intact and abbreviates the digest', () => {
    expect(displayImageRef(`ghcr.io/acme/officeqa-env:1.4.0@${DIGEST}`)).toBe(
      'ghcr.io/acme/officeqa-env:1.4.0@sha256:a1b2c3d4a1b2…'
    )
  })

  it('shortens to the requested width and leaves an unpinned ref alone', () => {
    expect(displayImageRef(`ghcr.io/acme/env:v3@${DIGEST}`, 8)).toBe(
      'ghcr.io/acme/env:v3@sha256:a1b2c3d4…'
    )
    expect(displayImageRef('ghcr.io/acme/env:v3')).toBe('ghcr.io/acme/env:v3')
  })

  it('does not mistake a host port for a tag, and survives a digest-only legacy pin', () => {
    expect(displayImageRef('registry.acme.dev:5000/team/app')).toBe(
      'registry.acme.dev:5000/team/app'
    )
    // No tag to show — the pre-fix pins look like this, which is exactly the unreadable case.
    expect(displayImageRef(`ghcr.io/acme/env@${DIGEST}`, 8)).toBe(
      'ghcr.io/acme/env@sha256:a1b2c3d4…'
    )
  })
})

describe('imageRepositoryOf — repository coordinates regardless of tag/digest', () => {
  it('strips both the tag and the digest', () => {
    expect(imageRepositoryOf(`ghcr.io/acme/env:v3@${DIGEST}`)).toBe('ghcr.io/acme/env')
    expect(imageRepositoryOf('registry.acme.dev:5000/team/app')).toBe(
      'registry.acme.dev:5000/team/app'
    )
  })
})
