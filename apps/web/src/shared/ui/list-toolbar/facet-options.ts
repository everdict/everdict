import type { FacetOption } from './facet-filter-menu'

// The values one axis actually offers — **only what is present in this collection**. Filling the assignee axis with every workspace member
// buries the menu under the names of people who never made anything, and picking one always gives an empty list.
//
// When some item has no value at all, a "none" bucket is appended last (the empty string is its name — a query parameter has
// no null). With no such item it is not appended: a choice that can select nothing is not a choice.
export function facetOptionsOf<T>(
  items: readonly T[],
  valuesOf: (item: T) => readonly string[],
  labelOf: (value: string) => string,
  unsetLabel?: string
): FacetOption[] {
  const values = new Set<string>()
  let sawUnset = false
  for (const item of items) {
    const own = valuesOf(item)
    if (own.length === 0) sawUnset = true
    for (const value of own) values.add(value)
  }
  const options = [...values]
    .map((value) => ({ value, label: labelOf(value) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return sawUnset && unsetLabel !== undefined
    ? [...options, { value: '', label: unsetLabel }]
    : options
}
