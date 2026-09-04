import type { IssueLabel } from '@/entities/issue-label'

// The arithmetic of label selection — kept outside the components so both surfaces (the edit dialog's field and the detail attribute column's
// control) move by the same rules.

// Attach and detach. The order is the order they were PICKED — picking a label already held removes it, and a newly picked one is appended.
export function toggleLabelId(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
}

// A label just created is not in the registry until the server sends the list down again. Copying the whole registry into state would diverge
// from the newest list the server gives (a label somebody else created would never appear), so only "the ones I created" are laid over the prop.
export function withCreatedLabels(registry: IssueLabel[], created: IssueLabel[]): IssueLabel[] {
  const known = new Set(registry.map((l) => l.id))
  const extra = created.filter((l) => !known.has(l.id))
  if (extra.length === 0) return registry
  return [...registry, ...extra].sort((a, b) => a.name.localeCompare(b.name))
}
