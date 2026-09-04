// Is a collapsible nav group expanded.
//
// A value the user toggled and had recorded WINS. "It contains the screen being looked at" is only the default when there is no record —
// that fact used to OVERRIDE the record (`holdsActive || recorded`), so a group holding the active item would not collapse even when its
// heading was pressed. Indistinguishable from a group that does not collapse, it reads as "the action is blocked".
//
// The active row disappearing along with a collapse is deliberate: moving as it was pressed comes before the sidebar telling you where you are
// (expand it again and the active row is still there).
export function navGroupOpen({
  recorded,
  holdsActive,
  whenUnrecorded = false,
}: {
  // The record of the user opening or closing this group themselves (including a value restored from localStorage). Absent, undefined.
  recorded: boolean | undefined
  holdsActive: boolean
  // The default when there is neither a record nor an active item (with only one team, for example, there is no reason to collapse it).
  whenUnrecorded?: boolean
}): boolean {
  return recorded ?? (holdsActive || whenUnrecorded)
}
