'use client'

import { useAnchorHighlight } from '@/shared/lib/use-anchor-highlight'

// "Your scheduled report is ready" points at ONE artifact in a gallery that keeps every pinned one — this
// scrolls to it and rings it. Rendered by the (server) gallery; draws nothing itself.
export function ArtifactAnchor() {
  useAnchorHighlight('artifact')
  return null
}
