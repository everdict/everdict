import { BadRequestError, type GradeContext, type Grader, type Score } from "@assay/core";

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
