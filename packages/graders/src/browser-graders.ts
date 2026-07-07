import { BadRequestError, type GradeContext, type Grader, type Score } from "@everdict/core";

// 최종 DOM 에 특정 텍스트가 있는지 (browser 스냅샷 대상).
export class DomContainsGrader implements Grader {
  readonly id = "dom-contains";
  constructor(private readonly needle: string) {}
  async grade(ctx: GradeContext): Promise<Score> {
    const snap = ctx.snapshot;
    if (snap.kind !== "browser") {
      throw new BadRequestError("BAD_REQUEST", { kind: snap.kind }, "dom-contains 는 browser 스냅샷이 필요합니다.");
    }
    const pass = snap.dom.includes(this.needle);
    return { graderId: this.id, metric: "dom_contains", value: pass ? 1 : 0, pass, detail: this.needle };
  }
}

// QA 벤치마크 outcome: 에이전트 최종 답(trace 의 마지막 assistant message)이 기대 답을 포함/일치하는지.
// WebVoyager/GAIA 류의 정답대조 채점. mode=contains(정규화 substring, 기본) | exact(정규화 완전일치).
export class AnswerMatchGrader implements Grader {
  readonly id = "answer-match";
  constructor(
    private readonly expect: string,
    private readonly mode: "contains" | "exact" = "contains",
  ) {}
  async grade(ctx: GradeContext): Promise<Score> {
    const msgs = ctx.trace.filter((e) => e.kind === "message" && e.role === "assistant");
    const last = msgs.at(-1);
    const answer = last && last.kind === "message" ? last.text : "";
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const a = norm(answer);
    const e = norm(this.expect);
    const pass = e === "" ? false : this.mode === "exact" ? a === e : a.includes(e);
    return { graderId: this.id, metric: "answer_match", value: pass ? 1 : 0, pass, detail: answer.slice(0, 120) };
  }
}

// 최종 URL 이 패턴(정규식)과 일치하는지.
export class UrlMatchesGrader implements Grader {
  readonly id = "url-matches";
  constructor(private readonly pattern: string) {}
  async grade(ctx: GradeContext): Promise<Score> {
    const snap = ctx.snapshot;
    if (snap.kind !== "browser") {
      throw new BadRequestError("BAD_REQUEST", { kind: snap.kind }, "url-matches 는 browser 스냅샷이 필요합니다.");
    }
    const pass = new RegExp(this.pattern).test(snap.url);
    return { graderId: this.id, metric: "url_matches", value: pass ? 1 : 0, pass, detail: this.pattern };
  }
}
