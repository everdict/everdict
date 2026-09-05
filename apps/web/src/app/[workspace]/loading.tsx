import { ListPageSkeleton } from '@/shared/ui/skeleton'

// The default loading boundary for every screen under a workspace.
//
// While this file did not exist, every navigation was **fully blocking**: pressing a filter chip froze the previous screen until the server
// render finished, with nothing to say whether it had been pressed at all. There was a quieter cost too —
// Next.js prefetches a dynamic route only **as far as its loading boundary**, so with no boundary `<Link>` prefetching was entirely
// pointless (every page is `force-dynamic`). One boundary undoes both at once.
//
// A screen needing a more specific shape overrides this default with a `loading.tsx` in its own segment (the issue list).
export default function WorkspaceLoading() {
  return <ListPageSkeleton />
}
