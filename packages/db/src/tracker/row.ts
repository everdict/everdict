import type { TrackerHistoryEntry } from "@everdict/contracts";

// Shared row shape for the tracker's three tables — they differ only in their own fields, so the identity,
// authorship, history and timestamp columns are described once.
export interface TrackerRow {
  id: string;
  tenant: string;
  history: unknown;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export const iso = (value: string | Date): string => (typeof value === "string" ? value : value.toISOString());

// The jsonb history column is validated by the record schema on the way out; this just gives the parse a
// well-formed array when the column is NULL (a pre-history row can only exist through a hand-written insert).
export function trackerHistory(value: unknown): TrackerHistoryEntry[] {
  return Array.isArray(value) ? (value as TrackerHistoryEntry[]) : [];
}

// The tracker's jsonb id lists (a project's teams and initiatives, an issue's former identifiers). Same
// treatment as history: hand the record schema a well-formed array so a NULL column from a row written before
// the column existed parses instead of throwing, and drop anything that is not a string rather than letting a
// malformed element reach the domain.
export function trackerIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
