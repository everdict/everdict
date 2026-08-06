import { canInTeam, type WebAction } from '@/shared/auth/can'

import type { TeamPickerOption } from '../ui/team-picker'

export interface OwnerChoices {
  teams: TeamPickerOption[]
  defaultTeamId?: string
}

// The owning-team choices a creation form offers — the write half of the team axis, the same rule the control
// plane's `teamForNew` gates (an admin files into any team, everyone else only into teams they are on), so the
// picker never offers a guaranteed 403. The default mirrors the server's implicit fallback — your first team,
// else the workspace default team — the picker makes WHERE the asset lands visible without changing where that is.
export function ownerChoicesFor(
  principal: { roles?: string[]; teams?: string[] } | null | undefined,
  teams: { id: string; key: string; name: string; isDefault: boolean }[],
  action: WebAction
): OwnerChoices {
  const writable = teams.filter((team) => canInTeam(principal, action, team.id))
  const own = (principal?.teams ?? []).find((id) => writable.some((team) => team.id === id))
  const preferred = own ?? (writable.find((team) => team.isDefault) ?? writable[0])?.id
  return {
    teams: writable.map(({ id, key, name }) => ({ id, key, name })),
    ...(preferred !== undefined ? { defaultTeamId: preferred } : {}),
  }
}
