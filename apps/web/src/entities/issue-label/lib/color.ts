import { ISSUE_LABEL_COLORS, type IssueLabelColor } from '../model/schema'

// Pick a colour from the name — with every new label born grey the palette might as well not exist (colour is the signal read BEFORE the name
// when sweeping a list). It is derived deterministically from the name rather than randomly for two reasons: the server and the client have to
// draw the same value (hydration), and someone who tried to create the same name twice seeing a different colour reads it as a colour they
// never picked having changed.
//
// Grey is never SUGGESTED — it can be chosen, but that is a decision to use no colour rather than a recommendation.
const SUGGESTABLE: IssueLabelColor[] = ISSUE_LABEL_COLORS.filter((color) => color !== 'gray')

export function suggestLabelColor(name: string): IssueLabelColor {
  const key = name.trim().toLocaleLowerCase()
  if (key === '') return 'gray'
  let hash = 0
  for (const character of key) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003
  return SUGGESTABLE[hash % SUGGESTABLE.length] ?? 'gray'
}
