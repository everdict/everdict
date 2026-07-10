import type { Dataset, DatasetDiff, DatasetFieldChange, EvalCase } from "@everdict/contracts";

// Key-sorted canonicalization — compares object key order/array equality stably (avoids false changes). undefined has a dedicated sentinel.
function canonical(v: unknown): string {
  if (v === undefined) return "@@undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

// Display string — strings like task as-is, others (objects/arrays/numbers) as JSON, "(none)" if absent.
function repr(v: unknown): string {
  if (v === undefined) return "(none)";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// EvalCase fields to compare (id is excluded as the matching key). Also the change-reporting order.
function caseFields(c: EvalCase): Record<string, unknown> {
  return {
    task: c.task,
    env: c.env,
    graders: c.graders,
    image: c.image,
    timeoutSec: c.timeoutSec,
    tags: c.tags,
    placement: c.placement,
  };
}

function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>): DatasetFieldChange[] {
  const out: DatasetFieldChange[] = [];
  for (const field of Object.keys(after)) {
    if (canonical(before[field]) !== canonical(after[field]))
      out.push({ field, before: repr(before[field]), after: repr(after[field]) });
  }
  return out;
}

// base ↔ candidate dataset version diff. Cases are matched by id — added if only in candidate,
// removed if only in base, field comparison if in both (changed if any field differs, unchanged otherwise).
// Dataset meta (description/tags) is reported the same way. The result is sorted by id (stable output).
export function diffDatasets(base: Dataset, candidate: Dataset): DatasetDiff {
  const baseById = new Map(base.cases.map((c) => [c.id, c] as const));
  const candById = new Map(candidate.cases.map((c) => [c.id, c] as const));

  const added: Array<{ id: string; task: string }> = [];
  const removed: Array<{ id: string; task: string }> = [];
  const changed: Array<{ id: string; changes: DatasetFieldChange[] }> = [];
  let unchanged = 0;

  for (const [id, c] of candById) {
    const b = baseById.get(id);
    if (!b) {
      added.push({ id, task: c.task });
      continue;
    }
    const changes = fieldChanges(caseFields(b), caseFields(c));
    if (changes.length > 0) changed.push({ id, changes });
    else unchanged++;
  }
  for (const [id, b] of baseById) if (!candById.has(id)) removed.push({ id, task: b.task });

  const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);
  added.sort(byId);
  removed.sort(byId);
  changed.sort(byId);

  const meta = fieldChanges(
    { description: base.description, tags: base.tags },
    { description: candidate.description, tags: candidate.tags },
  );

  return {
    id: candidate.id,
    base: base.version,
    candidate: candidate.version,
    meta,
    added,
    removed,
    changed,
    unchanged,
    summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
  };
}
