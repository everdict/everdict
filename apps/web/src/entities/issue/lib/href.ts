// An issue is addressed by the identifier its team stamped on it (`ENG-12`) — a pasted link then reads as the
// name people use for it in conversation. The control plane's /issues/:id takes both the id and the identifier,
// so old uuid links keep opening and the detail page normalizes the address when it renders. Every link goes
// through this function, so the spelling is decided in exactly one place.
//
// The segment is SINGULAR because it addresses one issue: `/{workspace}/issues` is the list, a different screen.
//
// The title rides along as a trailing slug (`/issue/ENG-12/the-judge-drops-cost-scores`), which is what makes a
// link pasted into a chat say what it leads to. It is DECORATIVE: nothing reads it, any value resolves, and a
// stale one left over from before a rename still opens the issue. Only the identifier decides what is shown.
export function issueHref(workspace: string, identifier: string, title?: string): string {
  const base = `/${workspace}/issue/${encodeURIComponent(identifier)}`
  const slug = title === undefined ? '' : issueSlug(title)
  return slug === '' ? base : `${base}/${slug}`
}

// How long a slug may be. Long enough to carry a real title, short enough that the address still fits in the
// places links get pasted.
const MAX_SLUG_LENGTH = 64

// Title → address segment. Letters and digits of ANY script survive (a Korean title keeps its words instead of
// slugging away to nothing); everything else collapses to a single hyphen. The result is percent-encoded, and
// browsers display it decoded, so a non-latin slug stays readable in the address bar.
export function issueSlug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (words.length <= MAX_SLUG_LENGTH) return encodeURIComponent(words)
  // Cut on a word boundary when there is one, so the tail is not half a word.
  const clipped = words.slice(0, MAX_SLUG_LENGTH)
  const lastBreak = clipped.lastIndexOf('-')
  return encodeURIComponent(lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped)
}
