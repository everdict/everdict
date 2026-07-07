import type { Dataset, DatasetDiff, DatasetFieldChange, EvalCase } from "@everdict/core";

// 키 정렬 정규화 — 객체 키 순서/배열 동등성을 안정적으로 비교(거짓 변경 방지). undefined 는 전용 센티넬.
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

// 표시용 문자열 — task 같은 문자열은 그대로, 그 외(객체/배열/수)는 JSON, 없으면 "(없음)".
function repr(v: unknown): string {
  if (v === undefined) return "(없음)";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// EvalCase 의 비교 대상 필드(id 는 매칭 키라 제외). 변경 보고 순서이기도 하다.
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

// base ↔ candidate 데이터셋 버전 diff. 케이스는 id 로 매칭 — candidate 에만 있으면 added,
// base 에만 있으면 removed, 둘 다 있으면 필드 비교(달라진 필드가 있으면 changed, 없으면 unchanged).
// 데이터셋 메타(description/tags)도 같은 방식으로 보고한다. 결과는 id 사전순 정렬(안정적 출력).
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
