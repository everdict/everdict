// An initiative detail is not one screen but **one place with tabs** (the same skeleton as Linear): the overview answers what the goal is and
// where it is now, the projects tab what stage the work beneath it is at, and the updates tab what the lead SAID about it.
// The three screens share the same header and attribute column, so the address is built in ONE place too — for the same reason as team slugs
// (assemble a link by hand and one of them eventually points somewhere else).
export const INITIATIVE_SECTIONS = ['overview', 'projects', 'updates'] as const
export type InitiativeSection = (typeof INITIATIVE_SECTIONS)[number]

// A goal's short address IS the overview — no further segment is appended.
export function initiativeHref(
  workspace: string,
  id: string,
  section: InitiativeSection = 'overview'
): string {
  const base = `/${workspace}/initiative/${encodeURIComponent(id)}`
  return section === 'overview' ? base : `${base}/${section}`
}
