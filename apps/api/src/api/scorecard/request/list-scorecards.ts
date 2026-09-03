import type { ScorecardGroupBy, ScorecardListFilter } from "@everdict/application-control";
import { ScorecardStatusSchema } from "@everdict/contracts";
import { z } from "zod";

// The scorecard LIST's query — shared by `GET /scorecards` (the rows) and `GET /scorecards/counts` (how many
// are in each group). ONE schema for both, for the same reason the issue list has one: a grouped screen draws
// them together — headers from the counts, rows from the page — and a narrow that applied to only one of the
// two would show a count the rows contradict.
//
// Why a page exists here at all: a scorecard is an EVENT a CI run files, not a registry entry a human
// authors, so the collection only grows. Every one of these narrows used to be applied in the BROWSER over
// the whole workspace's history, which is affordable exactly until it isn't.

// A facet is a SET, and a query string spells a set by repeating the key (`?status=failed&status=cancelled`).
// Fastify hands us a bare value for one and an array for several, so both spellings collapse here rather than
// at each call site — the same helper the issue list's query has.
function repeatable<T extends z.ZodType<string>>(item: T) {
  return z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(item).optional(),
  );
}

// The unset bucket is spelled as the EMPTY string (`?creator=`) — a query parameter has no null to offer, and
// "no owner" is a bucket people filter to. These therefore do not require a non-empty value.
const optionalRef = z.string().max(200);

export const ListScorecardsQuerySchema = z.object({
  judge: z.string().min(1).optional(),
  schedule: z.string().min(1).optional(),
  dataset: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  // The SCOPES: one value each, and the ones a detail-history read asks with (a judge's evaluations, a
  // schedule's runs).
  status: ScorecardStatusSchema.optional(),
  runtime: optionalRef.optional(),
  creator: optionalRef.optional(),
  // The FACETS: sets, because "any of these" is the question a list's filter menu asks. They AND with the
  // scopes above rather than replacing them.
  statuses: repeatable(ScorecardStatusSchema),
  datasets: repeatable(optionalRef),
  harnesses: repeatable(optionalRef),
  runtimes: repeatable(optionalRef),
  creators: repeatable(optionalRef),
  // A UTC calendar day (`YYYY-MM-DD`) — the same key the day grouping buckets a row under, which is the
  // stored instant's UTC date rather than the reader's local one.
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // Free text over the batch id and the two capability ids it names. Server-side because the alternative is
  // loading a window and filtering it in the client, which quietly stops finding batches once the workspace
  // outgrows the window.
  q: z.string().min(1).max(200).optional(),
});

export type ListScorecardsQuery = z.infer<typeof ListScorecardsQuerySchema>;

// The PAGE's own parameters. Separate from the filter because the counts endpoint has none of them: an
// aggregate is not paginated.
//
// The cursor is the last row you drew — its two ordering fields, plainly. Not an opaque token: the list's
// ordering (`createdAt` desc, `id` desc breaking the tie) is part of this endpoint's contract, so a caller
// holding the last row can already say "older than this" and there is nothing to encode, parse or forge.
// Two fields rather than one because the ordering is TOTAL only with the id — a cursor that carried the
// timestamp alone would repeat or skip a row at every boundary where two batches share an instant.
export const ScorecardPageQuerySchema = ListScorecardsQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(200).optional(),
  beforeCreatedAt: z.string().datetime().optional(),
  beforeId: z.string().min(1).optional(),
});

export type ScorecardPageQuery = z.infer<typeof ScorecardPageQuerySchema>;

// The grouping vocabulary, mirrored from the store port. The two guards below are the reason this is a
// `const` rather than a bare `z.enum`: `satisfies` refuses a value the port does not have, and `_covers`
// refuses a port value this list forgot — a schema that silently narrowed would 400 a legal grouping.
const SCORECARD_GROUP_BY = [
  "day",
  "status",
  "harness",
  "dataset",
  "creator",
] as const satisfies readonly ScorecardGroupBy[];
export type ScorecardGroupByCoverage = ScorecardGroupBy extends (typeof SCORECARD_GROUP_BY)[number] ? true : never;
export const ScorecardGroupBySchema = z.enum(SCORECARD_GROUP_BY);

export const ScorecardCountsQuerySchema = ListScorecardsQuerySchema.extend({
  groupBy: ScorecardGroupBySchema,
});

export type ScorecardCountsQuery = z.infer<typeof ScorecardCountsQuerySchema>;

// Query → store filter, in ONE place so the rows and the counts can never be narrowed differently.
//
// `judge` and `schedule` stay MUTUALLY EXCLUSIVE with each other and with the capability narrows, exactly as
// the route has always treated them: they are detail-history reads ("this judge's evaluations", "this
// schedule's runs"), not facets of the workspace list.
export function scorecardFilterOf(query: ListScorecardsQuery): ScorecardListFilter {
  const narrow: ScorecardListFilter = query.schedule
    ? { scheduleId: query.schedule }
    : query.judge
      ? { judge: query.judge }
      : {
          ...(query.dataset !== undefined ? { dataset: query.dataset } : {}),
          ...(query.harness !== undefined ? { harness: query.harness } : {}),
        };
  return {
    ...narrow,
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.runtime !== undefined ? { runtime: query.runtime } : {}),
    ...(query.creator !== undefined ? { createdBy: query.creator } : {}),
    ...(query.day !== undefined ? { day: query.day } : {}),
    ...(query.q !== undefined ? { search: query.q } : {}),
    ...(query.statuses !== undefined ? { statuses: query.statuses } : {}),
    ...(query.datasets !== undefined ? { datasets: query.datasets } : {}),
    ...(query.harnesses !== undefined ? { harnesses: query.harnesses } : {}),
    ...(query.runtimes !== undefined ? { runtimes: query.runtimes } : {}),
    ...(query.creators !== undefined ? { creators: query.creators } : {}),
  };
}

// The page's own bounds, kept OUT of `scorecardFilterOf` so a counts caller cannot accidentally pass them —
// a count narrowed by the cursor reports the page size back to the caller.
export function scorecardPageOf(query: ScorecardPageQuery): Pick<ScorecardListFilter, "limit" | "before"> {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    // Both halves or neither: a cursor missing its id is not a position in a total order.
    ...(query.beforeCreatedAt !== undefined && query.beforeId !== undefined
      ? { before: { createdAt: query.beforeCreatedAt, id: query.beforeId } }
      : {}),
  };
}
