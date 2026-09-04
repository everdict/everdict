import { fmtSubject } from '@/shared/lib/format'

import type { Member } from '../model/schema'

// subject → a person's identity. Only the opaque Keycloak subject survives on a record, so every screen that shows "who did it" goes through
// this lookup. This module holds PURE functions only — put in member-directory, which is `'use client'`, it could not be called from a server
// component (a client module's exports can only be REFERENCED from the server).
export type MemberProfile = { name: string; avatarUrl?: string }
export type MemberDirectory = Record<string, MemberProfile>

// The server-component assembly — it turns a listMembers result straight into a directory (the client uses useMemberDirectory).
export function memberDirectoryOf(members: readonly Member[]): MemberDirectory {
  const directory: MemberDirectory = {}
  for (const m of members) {
    directory[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
    }
  }
  return directory
}

// The name to show — the profile name, else an abbreviated subject (the directory has not arrived, or the member has left).
export function memberNameOf(directory: MemberDirectory, subject: string): string {
  return directory[subject]?.name ?? fmtSubject(subject)
}

// An API key subject (`key:<workspace>`) arrives as a member record too — a subject with no human name, so a "who created this" screen putting
// the raw subject where a person's name goes would expose an id. Such a subject is drawn with a label ("API key") instead.
export function isMachineSubject(subject: string): boolean {
  return subject.startsWith('key:')
}
