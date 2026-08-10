import type { PlatformFact, ReleaseRecord, ReleaseStatus } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { appendHistory } from "../tracker/history.js";
import type { ResolvedSeriesContract } from "./readiness.js";

// The Release aggregate — a checkpoint on the product's axis. Same {patch, facts} transition contract as the
// tracker; the released gate is the point: "we shipped" with open issues or a regressed watch series must be a
// recorded override, never a default.
export interface ReleaseTransition {
  patch: Partial<ReleaseRecord>;
  facts: PlatformFact[];
}

export interface NewReleaseInput {
  id: string;
  tenant: string;
  productId: string;
  name: string;
  description?: string;
  targetDate?: string;
  seriesKeys?: string[];
  // The product's declared series keys — the aggregate refuses a selection naming a series that does not
  // exist, because a release watching nothing it thinks it watches is a gate that silently always passes.
  productSeriesKeys: readonly string[];
  createdBy: string;
  now: string;
}

export interface ReleaseEditInput {
  name?: string;
  description?: string | null;
  targetDate?: string | null;
  // `null` clears the selection back to "every series".
  seriesKeys?: string[] | null;
}

export interface ReleaseStatusChangeInput {
  to: ReleaseStatus;
  // Open issues linked to this release (the readiness read's count — the caller counts, the domain decides).
  openIssues: number;
  // The keys of watched series BLOCKING the ship — releaseReadiness's derivation over the SCORECARD GATE's
  // verdicts (required && verdict ∉ {pass, no_baseline}); the field name predates the verdict vocabulary.
  regressedSeries: readonly string[];
  // The per-series verdict snapshot at DECISION time (arch-review 7, the ReleaseDecision evidence): recorded
  // into the history entry so a shipped release keeps WHAT its gate saw — the live readiness keeps moving.
  // The ship-time decision per watched series — evidence references, not verdict words. Both sides carry
  // the scoring pin that says WHICH judgment was read, which is what makes the next release able to anchor
  // on this exact decision instead of re-searching by time (and reading a plane a re-score has since moved).
  seriesDecisions?: ReadonlyArray<{
    key: string;
    verdict: string;
    required?: boolean;
    reasons?: readonly string[];
    baseline?: { scorecardId: string; scoring?: { revision: number; scorePlaneDigest: string } };
    candidate?: { scorecardId: string; scoring?: { revision: number; scorePlaneDigest: string } };
    // WHICH QUESTION this series was judged on (arch-review 14 §9). The decision recorded which scorecards
    // and which judgments, and not what they were asked — so "what did the last ship actually pass?" could
    // only be answered by walking to a scorecard that may since have been deleted, and the DECISION itself
    // was not self-describing. The digest identifies it; the document makes it readable without any external
    // mutable state, which is the same reason the product policy is embedded rather than digested.
    // The SHARED type, not a copy of it (arch-review 15 §15). Re-declaring the shape here dropped
    // `serviceModels` and the judge closure's delegated `harness` — and a type that omits a field tells every
    // downstream reader the field does not exist, which is how two declarations of one concept drift apart
    // while the runtime quietly carries both.
    evaluationContract?: { digest: string } & ResolvedSeriesContract;
  }>;
  // The product policy this decision stood on (series membership + required/bootstrap flags) — as a
  // DOCUMENT, because a digest of a mutable record is one-way: it detects that the policy changed and can
  // never say what it was. "Which series gated this ship, and had a bootstrap been pre-approved?" is the
  // first question a regression post-mortem asks, and the digest alone could not answer it once the product
  // had been edited. Scoped to the WATCHED series — the policy this decision actually evaluated.
  productPolicy?: ReadonlyArray<{ key: string; required: boolean; allowNoBaseline: boolean }>;
  productPolicyDigest?: string;
  force?: boolean;
}

function assertSeriesSelection(keys: readonly string[], productSeriesKeys: readonly string[], releaseId: string): void {
  for (const key of keys) {
    if (!productSeriesKeys.includes(key))
      throw new BadRequestError(
        "BAD_REQUEST",
        { release: releaseId, series: key },
        `The product declares no series "${key}" — a release can only watch series its product has.`,
      );
  }
}

function releasedOnTime(targetDate: string | undefined, now: string): boolean | undefined {
  if (targetDate === undefined) return undefined;
  return now.slice(0, 10) <= targetDate;
}

export class Release {
  private constructor(private readonly record: ReleaseRecord) {}

  static from(record: ReleaseRecord): Release {
    return new Release(record);
  }

  static newRelease(input: NewReleaseInput): ReleaseRecord {
    if (input.seriesKeys !== undefined) assertSeriesSelection(input.seriesKeys, input.productSeriesKeys, input.id);
    return {
      id: input.id,
      tenant: input.tenant,
      productId: input.productId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      // A release starts PLANNED — a date and a scope somebody committed to; `released` is a gated transition.
      status: "planned",
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      ...(input.seriesKeys !== undefined ? { seriesKeys: input.seriesKeys } : {}),
      // FREEZE the scope this release commits to (arch-review 12 P0). A release is "a date and a scope
      // somebody committed to" and the scope was re-derived from the product's current series on every
      // read — so deleting a series removed the gate instead of failing it. What is promised here is what
      // the readiness check demands to still find.
      seriesSelection: input.seriesKeys !== undefined ? "explicit" : "all",
      plannedSeriesKeys: input.seriesKeys !== undefined ? [...input.seriesKeys] : [...input.productSeriesKeys],
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: { status: "planned", ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}) },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: ReleaseRecord): PlatformFact[] {
    return [
      {
        kind: "release.created",
        subject: { type: "release", id: record.id },
        actor: record.createdBy,
        payload: {
          productId: record.productId,
          name: record.name,
          ...(record.targetDate !== undefined ? { targetDate: record.targetDate } : {}),
        },
        message: `Release planned — ${record.name}`,
      },
    ];
  }

  get status(): ReleaseStatus {
    return this.record.status;
  }

  update(fields: ReleaseEditInput, by: string, now: string, productSeriesKeys: readonly string[]): ReleaseTransition {
    const changed: string[] = [];
    const patch: Partial<ReleaseRecord> = {};
    if (fields.name !== undefined && fields.name !== this.record.name) {
      patch.name = fields.name;
      changed.push("name");
    }
    if (fields.description !== undefined) {
      const next = fields.description === null ? undefined : fields.description;
      if (next !== this.record.description) {
        patch.description = next;
        changed.push("description");
      }
    }
    if (fields.targetDate !== undefined) {
      const next = fields.targetDate === null ? undefined : fields.targetDate;
      if (next !== this.record.targetDate) {
        patch.targetDate = next;
        changed.push("targetDate");
      }
    }
    if (fields.seriesKeys !== undefined) {
      const next = fields.seriesKeys === null ? undefined : fields.seriesKeys;
      if (next !== undefined) assertSeriesSelection(next, productSeriesKeys, this.record.id);
      if ((next ?? []).join("\0") !== (this.record.seriesKeys ?? []).join("\0")) {
        patch.seriesKeys = next;
        // Re-scoping RE-FREEZES the promise (arch-review 12 P0) — an edit is a new commitment, and leaving
        // the old frozen keys would make the release demand gates it just decided not to watch. Clearing the
        // selection re-freezes against the product's series as they are NOW, which is what "all" was just
        // chosen to mean.
        patch.seriesSelection = next !== undefined ? "explicit" : "all";
        patch.plannedSeriesKeys = next !== undefined ? [...next] : [...productSeriesKeys];
        changed.push("seriesKeys");
      }
    }
    if (changed.length === 0)
      throw new BadRequestError("BAD_REQUEST", { release: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, { at: now, by, event: "updated", detail: { changed } });
    patch.updatedAt = now;
    return { patch, facts: [] };
  }

  // The release gate. Refusing here is the point: "did everything this release watches actually hold" gets a
  // definite answer, and shipping anyway is an explicit, recorded override — never a default.
  setStatus(input: ReleaseStatusChangeInput, by: string, now: string): ReleaseTransition {
    const from = this.record.status;
    const { to, openIssues, regressedSeries } = input;
    if (to === from)
      throw new ConflictError("CONFLICT", { release: this.record.id, status: from }, `Release is already ${from}.`);
    if (from === "released")
      throw new ConflictError(
        "CONFLICT",
        { release: this.record.id },
        "A released release is history — plan a new one instead of reopening it.",
      );
    const blocked = openIssues > 0 || regressedSeries.length > 0;
    if (to === "released" && blocked && input.force !== true) {
      const reasons = [
        ...(openIssues > 0 ? [`${openIssues} linked issue(s) still open`] : []),
        ...(regressedSeries.length > 0 ? [`blocking series: ${regressedSeries.join(", ")}`] : []),
      ];
      throw new ConflictError(
        "CONFLICT",
        { release: this.record.id, openIssues, regressedSeries: [...regressedSeries] },
        `Not ready to release — ${reasons.join("; ")}. Resolve them, or release with force.`,
      );
    }
    const onTime = to === "released" ? releasedOnTime(this.record.targetDate, now) : undefined;
    const forced = to === "released" && blocked;
    const detail = {
      from,
      to,
      openIssues,
      ...(regressedSeries.length > 0 ? { regressedSeries: [...regressedSeries] } : {}),
      // The ship-time evidence snapshot: WHICH verdict each watched series carried when this decision was
      // made — the history entry is the release's ledger, and the live readiness read keeps moving after.
      // The ship-time DECISION (arch-review 8 P1). `{key, verdict}` could not answer any question a month
      // later — which scorecards, which judgments, what was the baseline, was this series even required —
      // and the next release resolved its baseline by re-searching time, so a post-ship re-score silently
      // changed what "we compared against last time" meant. The decision now records the evidence it stood
      // on: both sides with their scoring pins, whether the series gated, and why.
      ...(to === "released" && input.seriesDecisions?.length
        ? {
            seriesDecisions: input.seriesDecisions.map((d) => ({
              key: d.key,
              verdict: d.verdict,
              ...(d.required !== undefined ? { required: d.required } : {}),
              ...(d.reasons?.length ? { reasons: [...d.reasons] } : {}),
              ...(d.baseline ? { baseline: d.baseline } : {}),
              ...(d.candidate ? { candidate: d.candidate } : {}),
              ...(d.evaluationContract ? { evaluationContract: d.evaluationContract } : {}),
            })),
          }
        : {}),
      // WHICH product policy this decision stood on — series membership and their required/bootstrap flags
      // are editable, so a decision that does not name its policy cannot be re-derived. The DOCUMENT is what
      // makes it re-derivable; the digest is the cheap "did it change" check beside it.
      ...(to === "released" && input.productPolicy?.length
        ? { productPolicy: input.productPolicy.map((s) => ({ ...s })) }
        : {}),
      ...(to === "released" && input.productPolicyDigest !== undefined
        ? { productPolicyDigest: input.productPolicyDigest }
        : {}),
      ...(onTime !== undefined ? { onTime } : {}),
      ...(forced ? { forced: true } : {}),
    };
    const patch: Partial<ReleaseRecord> = {
      status: to,
      history: appendHistory(this.record.history, {
        at: now,
        by,
        event: to === "released" ? "released" : to === "cancelled" ? "cancelled" : "status_changed",
        detail,
      }),
      updatedAt: now,
    };
    patch.releasedAt = to === "released" ? now : undefined;
    return {
      patch,
      facts: [
        {
          kind: "release.status_changed",
          subject: { type: "release", id: this.record.id },
          actor: by,
          payload: {
            from,
            to,
            productId: this.record.productId,
            name: this.record.name,
            openIssues,
            ...(regressedSeries.length > 0 ? { regressedSeries: [...regressedSeries] } : {}),
            ...(onTime !== undefined ? { onTime } : {}),
            ...(forced ? { forced: true } : {}),
          },
          message: `Release ${from} → ${to} — ${this.record.name}`,
        },
      ],
    };
  }
}
