import type { GradeContext, TraceEvent } from "@assay/core";
import { describe, expect, it } from "vitest";
import { DomContainsGrader, UrlMatchesGrader } from "./browser-graders.js";
import { type Judge, JudgeGrader } from "./judge.js";
import { makeGraders } from "./make-graders.js";

function browserCtx(dom: string, url: string): GradeContext {
  return {
    case: { id: "c", env: { kind: "browser", startUrl: url }, task: "buy item", graders: [], timeoutSec: 1, tags: [] },
    trace: [] as TraceEvent[],
    snapshot: { kind: "browser", url, dom, console: [] },
  };
}

describe("browser graders", () => {
  it("dom-contains 통과/실패", async () => {
    expect((await new DomContainsGrader("Success").grade(browserCtx("<div>Success</div>", "https://x"))).pass).toBe(
      true,
    );
    expect((await new DomContainsGrader("Nope").grade(browserCtx("<div>Success</div>", "https://x"))).pass).toBe(false);
  });
  it("url-matches", async () => {
    expect((await new UrlMatchesGrader("/done$").grade(browserCtx("", "https://x/done"))).pass).toBe(true);
  });
  it("repo 스냅샷이면 에러", async () => {
    const ctx: GradeContext = {
      case: browserCtx("", "").case,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    };
    await expect(new DomContainsGrader("x").grade(ctx)).rejects.toThrow();
  });
});

describe("JudgeGrader", () => {
  const mockJudge: Judge = {
    async judge() {
      return { pass: true, score: 0.9, reason: "looks good" };
    },
  };
  it("Judge 판정을 Score 로 변환한다", async () => {
    const score = await new JudgeGrader(mockJudge, { id: "vlm-judge", useScreenshot: true }).grade(
      browserCtx("<html/>", "https://x"),
    );
    expect(score.graderId).toBe("vlm-judge");
    expect(score.pass).toBe(true);
    expect(score.value).toBe(0.9);
  });
});

describe("makeGraders", () => {
  it("spec 으로 그레이더를 만든다", () => {
    const g = makeGraders([
      { id: "steps" },
      { id: "dom-contains", config: { text: "ok" } },
      { id: "url-matches", config: { pattern: "/x" } },
    ]);
    expect(g.map((x) => x.id)).toEqual(["steps", "dom-contains", "url-matches"]);
  });
  it("알 수 없는 그레이더는 에러", () => {
    expect(() => makeGraders([{ id: "nope" }])).toThrow();
  });
});
