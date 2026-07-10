import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/contracts";

// Whether the final DOM contains specific text (browser snapshot target).
export class DomContainsGrader implements Grader {
  readonly id = "dom-contains";
  constructor(private readonly needle: string) {}
  async grade(ctx: GradeContext): Promise<Score> {
    const snap = ctx.snapshot;
    if (snap.kind !== "browser") {
      throw new BadRequestError("BAD_REQUEST", { kind: snap.kind }, "dom-contains requires a browser snapshot.");
    }
    const pass = snap.dom.includes(this.needle);
    return { graderId: this.id, metric: "dom_contains", value: pass ? 1 : 0, pass, detail: this.needle };
  }
}

// QA benchmark outcome: whether the agent's final answer (the last assistant message in the trace) contains/matches the expected answer.
// WebVoyager/GAIA-style answer-matching scoring. mode=contains (normalized substring, default) | exact (normalized full match).
// The expected answer comes from the grader config, falling back to the case's own `expected` row data (dataset
// purification — the reference output is case DATA, not grader config). docs/architecture/eval-domain-model.md S5
export class AnswerMatchGrader implements Grader {
  readonly id = "answer-match";
  constructor(
    private readonly expect?: string,
    private readonly mode: "contains" | "exact" = "contains",
  ) {}
  async grade(ctx: GradeContext): Promise<Score> {
    const msgs = ctx.trace.filter((e) => e.kind === "message" && e.role === "assistant");
    const last = msgs.at(-1);
    const answer = last && last.kind === "message" ? last.text : "";
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const a = norm(answer);
    const e = norm(this.expect ?? ctx.case.expected ?? "");
    const pass = e === "" ? false : this.mode === "exact" ? a === e : a.includes(e);
    return { graderId: this.id, metric: "answer_match", value: pass ? 1 : 0, pass, detail: answer.slice(0, 120) };
  }
}

// Whether the final URL matches the pattern (regex).
export class UrlMatchesGrader implements Grader {
  readonly id = "url-matches";
  constructor(private readonly pattern: string) {}
  async grade(ctx: GradeContext): Promise<Score> {
    const snap = ctx.snapshot;
    if (snap.kind !== "browser") {
      throw new BadRequestError("BAD_REQUEST", { kind: snap.kind }, "url-matches requires a browser snapshot.");
    }
    const pass = new RegExp(this.pattern).test(snap.url);
    return { graderId: this.id, metric: "url_matches", value: pass ? 1 : 0, pass, detail: this.pattern };
  }
}
