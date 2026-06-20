import type { GradeContext, TraceEvent } from "@assay/core";
import { describe, expect, it } from "vitest";
import { AnswerMatchGrader, DomContainsGrader, UrlMatchesGrader } from "./browser-graders.js";
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

describe("answer-match grader (QA 벤치마크 정답대조)", () => {
  const ctxWithAnswer = (text: string): GradeContext => ({
    case: { id: "c", env: { kind: "browser", startUrl: "https://x" }, task: "q", graders: [], timeoutSec: 1, tags: [] },
    trace: [{ t: 0, kind: "message", role: "assistant", text }] as TraceEvent[],
    snapshot: { kind: "browser", url: "https://x", dom: "", console: [] },
  });
  it("정규화 substring 으로 정답 포함 여부 채점", async () => {
    expect(
      (await new AnswerMatchGrader("Example Domain").grade(ctxWithAnswer("The heading is: Example Domain."))).pass,
    ).toBe(true);
    expect((await new AnswerMatchGrader("1991").grade(ctxWithAnswer("Python was first released in 1991."))).pass).toBe(
      true,
    );
    expect((await new AnswerMatchGrader("404").grade(ctxWithAnswer("It means Not Found."))).pass).toBe(false);
  });
  it("exact 모드 + 마지막 assistant message 사용", async () => {
    expect((await new AnswerMatchGrader("example domain", "exact").grade(ctxWithAnswer("Example Domain"))).pass).toBe(
      true,
    );
    expect(
      (await new AnswerMatchGrader("example domain", "exact").grade(ctxWithAnswer("Example Domain page"))).pass,
    ).toBe(false);
  });
  it("makeGraders answer-match", () => {
    const g = makeGraders([{ id: "answer-match", config: { expect: "x" } }]);
    expect(g[0]?.id).toBe("answer-match");
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

  it("os-use 스냅샷: 환경에서 스크린샷을 base64 로 읽어 VLM 입력(screenshot)으로 넘긴다", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: true, score: 1, reason: "goal state shown" };
      },
    };
    const calls: string[] = [];
    const compute = {
      async exec(cmd: string) {
        calls.push(cmd);
        return { exitCode: 0, stdout: "QkFTRTY0\n", stderr: "" }; // base64 stdout(개행 포함)
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    const ctx: GradeContext = {
      case: { id: "c", env: { kind: "os-use" }, task: "open the remote form", graders: [], timeoutSec: 1, tags: [] },
      trace: [] as TraceEvent[],
      snapshot: { kind: "os-use", screenshotRef: "/tmp/assay-screen.png", windows: [] },
      compute,
    };
    const score = await new JudgeGrader(spy, { id: "vlm", useScreenshot: true }).grade(ctx);
    expect(score.pass).toBe(true);
    expect(calls[0]).toContain("base64 -w0");
    expect(calls[0]).toContain("/tmp/assay-screen.png");
    expect(received?.screenshot).toEqual({ base64: "QkFTRTY0", mediaType: "image/png" }); // 개행 trim + png
  });

  it("useScreenshot 가 false 면 os-use 라도 스크린샷을 읽지 않는다", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: false, score: 0, reason: "no" };
      },
    };
    let execCalls = 0;
    const compute = {
      async exec() {
        execCalls++;
        return { exitCode: 0, stdout: "x", stderr: "" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    const ctx: GradeContext = {
      case: { id: "c", env: { kind: "os-use" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
      trace: [] as TraceEvent[],
      snapshot: { kind: "os-use", screenshotRef: "/tmp/s.png", windows: [] },
      compute,
    };
    await new JudgeGrader(spy, { useScreenshot: false }).grade(ctx);
    expect(execCalls).toBe(0);
    expect(received?.screenshot).toBeUndefined();
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
  it("judge 스펙은 Judge 주입이 있어야 만들어진다(없으면 명시 에러)", () => {
    expect(() => makeGraders([{ id: "judge", config: { rubric: "r" } }])).toThrow(/Judge 주입/);
    const judge: Judge = {
      async judge() {
        return { pass: true, score: 1, reason: "ok" };
      },
    };
    const g = makeGraders([{ id: "judge", config: { id: "wv-judge", rubric: "r" } }], { judge });
    expect(g[0]?.id).toBe("wv-judge"); // config.id 로 grader id 지정
  });
});
