import {
  BUILTIN_GRADER_OWNED_METRICS,
  NO_IMAGE,
  RESERVED_AUTHORITY_METRICS,
  builtInOwnedMetrics,
} from "@everdict/contracts";
import { type GradeContext, type TraceEvent, measuredScores, toScores } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { AnswerMatchGrader, DomContainsGrader, UrlMatchesGrader } from "./browser-graders.js";
import { type Judge, JudgeGrader } from "./judge.js";
import { makeGraders } from "./make-graders.js";

const OBS_NONE = { kind: "unobserved", reason: "no_environment" } as const;

function browserCtx(dom: string, url: string): GradeContext {
  return {
    deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
    observations: OBS_NONE,
    case: { id: "c", env: { kind: "browser", startUrl: url }, task: "buy item", graders: [], timeoutSec: 1, tags: [] },
    trace: [] as TraceEvent[],
    snapshot: { kind: "browser", url, dom, console: [] },
  };
}

describe("browser graders", () => {
  it("dom-contains pass/fail", async () => {
    expect((await new DomContainsGrader("Success").grade(browserCtx("<div>Success</div>", "https://x"))).pass).toBe(
      true,
    );
    expect((await new DomContainsGrader("Nope").grade(browserCtx("<div>Success</div>", "https://x"))).pass).toBe(false);
  });
  it("url-matches", async () => {
    expect((await new UrlMatchesGrader("/done$").grade(browserCtx("", "https://x/done"))).pass).toBe(true);
  });
  it("errors on a repo snapshot", async () => {
    const ctx: GradeContext = {
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      observations: OBS_NONE,
      case: browserCtx("", "").case,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    };
    await expect(new DomContainsGrader("x").grade(ctx)).rejects.toThrow();
  });
});

describe("answer-match grader (QA benchmark answer matching)", () => {
  const ctxWithAnswer = (text: string): GradeContext => ({
    deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
    observations: OBS_NONE,
    case: { id: "c", env: { kind: "browser", startUrl: "https://x" }, task: "q", graders: [], timeoutSec: 1, tags: [] },
    trace: [{ t: 0, kind: "message", role: "assistant", text }] as TraceEvent[],
    snapshot: { kind: "browser", url: "https://x", dom: "", console: [] },
  });
  it("scores answer inclusion via normalized substring", async () => {
    expect(
      (await new AnswerMatchGrader("Example Domain").grade(ctxWithAnswer("The heading is: Example Domain."))).pass,
    ).toBe(true);
    expect((await new AnswerMatchGrader("1991").grade(ctxWithAnswer("Python was first released in 1991."))).pass).toBe(
      true,
    );
    expect((await new AnswerMatchGrader("404").grade(ctxWithAnswer("It means Not Found."))).pass).toBe(false);
  });
  it("exact mode + uses the last assistant message", async () => {
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

  it("falls back to the case's own `expected` row data; an explicit expect config wins (dataset purification)", async () => {
    const base = ctxWithAnswer("Python was first released in 1991.");
    const ctx: GradeContext = { ...base, case: { ...base.case, expected: "1991" } };
    // No config → the case row data decides.
    expect((await new AnswerMatchGrader().grade(ctx)).pass).toBe(true);
    // Config wins over the row data.
    expect((await new AnswerMatchGrader("2020").grade(ctx)).pass).toBe(false);
    // makeGraders without expect config leaves the fallback open (regression: "" used to block it).
    const [g] = makeGraders([{ id: "answer-match" }]);
    const [score] = measuredScores(toScores((await g?.grade(ctx)) ?? []));
    expect(score?.pass).toBe(true);
  });
});

describe("JudgeGrader", () => {
  const mockJudge: Judge = {
    async judge() {
      return { pass: true, score: 0.9, reason: "looks good" };
    },
  };
  it("converts a Judge verdict to a Score", async () => {
    const [score] = measuredScores(
      toScores(
        await new JudgeGrader(mockJudge, { id: "vlm-judge", useScreenshot: true }).grade(
          browserCtx("<html/>", "https://x"),
        ),
      ),
    );
    expect(score?.graderId).toBe("vlm-judge");
    expect(score?.pass).toBe(true);
    expect(score?.value).toBe(0.9);
  });

  it("with criteria, one judge call emits the overall Score plus one Score per criterion (multi-metric)", async () => {
    const criteria = [
      { id: "accuracy", description: "is it right", weight: 2 },
      { id: "style", description: "is it clean", weight: 1 },
    ];
    const judge: Judge = {
      async judge(input) {
        expect(input.criteria?.map((c) => c.id)).toEqual(["accuracy", "style"]);
        return {
          pass: true,
          score: 0.8,
          reason: "overall",
          criteria: {
            accuracy: { pass: true, score: 0.9, reason: "right" },
            style: { pass: false, score: 0.5, reason: "messy" },
          },
        };
      },
    };
    const scores = toScores(
      await new JudgeGrader(judge, { id: "quality", criteria }).grade(browserCtx("<html/>", "https://x")),
    );
    expect(scores.map((s) => s.metric)).toEqual(["judge", "judge:accuracy", "judge:style"]);
    expect(scores[0]).toMatchObject({ graderId: "quality", value: 0.8, pass: true });
    expect(scores[1]).toMatchObject({ graderId: "quality", value: 0.9, pass: true, detail: "right" });
    expect(scores[2]).toMatchObject({ graderId: "quality", value: 0.5, pass: false, detail: "messy" });
  });

  it("a case's milestones merge into the criteria — one call scores judge:milestone:<id> per intermediate step", async () => {
    const ctx = browserCtx("<html/>", "https://x");
    ctx.case = {
      ...ctx.case,
      milestones: [
        { id: "login", description: "logged in as the test user" },
        { id: "search", description: "searched for the product" },
      ],
    };
    const judge: Judge = {
      async judge(input) {
        // the milestone criteria (with their case-defined descriptions) reach the ONE verdict call
        expect(input.criteria?.map((c) => c.id)).toEqual(["milestone:login", "milestone:search"]);
        expect(input.criteria?.[0]?.description).toBe("logged in as the test user");
        return {
          pass: false,
          score: 0.3,
          reason: "failed at search",
          criteria: {
            "milestone:login": { pass: true, score: 1, reason: "login span present" },
            "milestone:search": { pass: false, score: 0, reason: "no search action in the trace" },
          },
        };
      },
    };
    const scores = toScores(await new JudgeGrader(judge, { id: "e2e" }).grade(ctx));
    expect(scores.map((s) => s.metric)).toEqual(["judge", "judge:milestone:login", "judge:milestone:search"]);
    expect(scores[1]).toMatchObject({ pass: true });
    expect(scores[2]).toMatchObject({ pass: false, detail: "no search action in the trace" });
  });

  it("milestones append AFTER the judge's own criteria (both scored in the same call)", async () => {
    const ctx = browserCtx("<html/>", "https://x");
    ctx.case = { ...ctx.case, milestones: [{ id: "login", description: "logged in" }] };
    const judge: Judge = {
      async judge(input) {
        expect(input.criteria?.map((c) => c.id)).toEqual(["accuracy", "milestone:login"]);
        return {
          pass: true,
          score: 1,
          reason: "ok",
          criteria: {
            accuracy: { pass: true, score: 1, reason: "r" },
            "milestone:login": { pass: true, score: 1, reason: "m" },
          },
        };
      },
    };
    const scores = toScores(
      await new JudgeGrader(judge, { id: "q", criteria: [{ id: "accuracy", description: "d", weight: 1 }] }).grade(ctx),
    );
    expect(scores.map((s) => s.metric)).toEqual(["judge", "judge:accuracy", "judge:milestone:login"]);
  });

  it("a Judge impl that ignores criteria yields visible per-criterion skips (never a silent drop)", async () => {
    const judge: Judge = {
      async judge() {
        return { pass: true, score: 1, reason: "no criteria support" };
      },
    };
    const scores = toScores(
      await new JudgeGrader(judge, { criteria: [{ id: "accuracy", description: "d", weight: 1 }] }).grade(
        browserCtx("<html/>", "https://x"),
      ),
    );
    // A criterion the Judge impl never scored is an UNMEASURED row — it used to be a value:0 kept out of the
    // aggregates only by its "skipped: " prose, which is exactly the sentinel the algebra retired.
    expect(scores[1]).toEqual({
      graderId: "judge",
      metric: "judge:accuracy",
      status: "unmeasured",
      reason: "unsupported",
      retryable: false,
      detail: "skipped: criterion missing from the verdict",
    });
  });

  it("passes the case's expected output to the judge (EXPECTED OUTPUT evidence)", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: true, score: 1, reason: "ok" };
      },
    };
    const base = browserCtx("<html/>", "https://x");
    const ctx: GradeContext = { ...base, case: { ...base.case, expected: "the reference answer" } };
    await new JudgeGrader(spy).grade(ctx);
    expect(received?.expected).toBe("the reference answer");
  });

  it("passes the prompt snapshot's output to the judge as the final response (regression: judges got an empty snapshot for trace-less runs)", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: true, score: 1, reason: "ok" };
      },
    };
    const ctx: GradeContext = {
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      observations: OBS_NONE,
      case: { id: "c", env: { kind: "prompt" }, task: "answer q", graders: [], timeoutSec: 1, tags: [] },
      trace: [] as TraceEvent[],
      snapshot: { kind: "prompt", output: "the final response body" },
    };
    await new JudgeGrader(spy).grade(ctx);
    expect(received?.response).toBe("the final response body");
  });

  it("does not pass a response for an empty prompt output (nothing to add as evidence)", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: true, score: 1, reason: "ok" };
      },
    };
    const ctx: GradeContext = {
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      observations: OBS_NONE,
      case: { id: "c", env: { kind: "prompt" }, task: "answer q", graders: [], timeoutSec: 1, tags: [] },
      trace: [] as TraceEvent[],
      snapshot: { kind: "prompt", output: "" },
    };
    await new JudgeGrader(spy).grade(ctx);
    expect(received?.response).toBeUndefined();
  });

  it("os-use snapshot: reads the screenshot as base64 from the environment and passes it as VLM input (screenshot)", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: true, score: 1, reason: "goal state shown" };
      },
    };
    const calls: string[] = [];
    const compute = {
      image: NO_IMAGE,
      async exec(cmd: string) {
        calls.push(cmd);
        return { exitCode: 0, stdout: "QkFTRTY0\n", stderr: "" }; // base64 stdout (with newline)
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    const ctx: GradeContext = {
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      observations: OBS_NONE,
      case: { id: "c", env: { kind: "os-use" }, task: "open the remote form", graders: [], timeoutSec: 1, tags: [] },
      trace: [] as TraceEvent[],
      snapshot: { kind: "os-use", screenshotRef: "/tmp/everdict-screen.png", screenshot: "", windows: [] }, // none embedded → compute fallback
      compute,
    };
    const [score] = measuredScores(toScores(await new JudgeGrader(spy, { id: "vlm", useScreenshot: true }).grade(ctx)));
    expect(score?.pass).toBe(true);
    expect(calls[0]).toContain("base64 -w0");
    expect(calls[0]).toContain("/tmp/everdict-screen.png");
    expect(received?.screenshot).toEqual({ base64: "QkFTRTY0", mediaType: "image/png" }); // newline trimmed + png
  });

  it("uses the embedded base64 as-is without compute when the os-use snapshot includes it (after result scoring/dispose)", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: true, score: 1, reason: "ok" };
      },
    };
    let execCalls = 0;
    const compute = {
      image: NO_IMAGE,
      async exec() {
        execCalls++;
        return { exitCode: 0, stdout: "SHOULD_NOT_BE_USED", stderr: "" };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
      async dispose() {},
    };
    const ctx: GradeContext = {
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      observations: OBS_NONE,
      case: { id: "c", env: { kind: "os-use" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
      trace: [] as TraceEvent[],
      snapshot: { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "RU1CRURERUQ=", windows: [] },
      compute,
    };
    await new JudgeGrader(spy, { useScreenshot: true }).grade(ctx);
    expect(execCalls).toBe(0); // uses embedded base64 → no compute exec
    expect(received?.screenshot).toEqual({ base64: "RU1CRURERUQ=", mediaType: "image/png" });
  });

  it("does not read the screenshot even for os-use when useScreenshot is false", async () => {
    let received: Parameters<Judge["judge"]>[0] | undefined;
    const spy: Judge = {
      async judge(input) {
        received = input;
        return { pass: false, score: 0, reason: "no" };
      },
    };
    let execCalls = 0;
    const compute = {
      image: NO_IMAGE,
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
      deadlineAt: Date.now() + 60_000, // one shared deadline for the case's whole scoring phase
      observations: OBS_NONE,
      case: { id: "c", env: { kind: "os-use" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
      trace: [] as TraceEvent[],
      snapshot: { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "", windows: [] },
      compute,
    };
    await new JudgeGrader(spy, { useScreenshot: false }).grade(ctx);
    expect(execCalls).toBe(0);
    expect(received?.screenshot).toBeUndefined();
  });
});

describe("makeGraders", () => {
  it("builds graders from specs", () => {
    const g = makeGraders([
      { id: "steps" },
      { id: "dom-contains", config: { text: "ok" } },
      { id: "url-matches", config: { pattern: "/x" } },
    ]);
    expect(g.map((x) => x.id)).toEqual(["steps", "dom-contains", "url-matches"]);
  });
  it("errors on an unknown grader", () => {
    expect(() => makeGraders([{ id: "nope" }])).toThrow();
  });
  it("a judge spec is only built with an injected Judge (explicit error otherwise)", () => {
    expect(() => makeGraders([{ id: "judge", config: { rubric: "r" } }])).toThrow(/Judge injection/);
    const judge: Judge = {
      async judge() {
        return { pass: true, score: 1, reason: "ok" };
      },
    };
    const g = makeGraders([{ id: "judge", config: { id: "wv-judge", rubric: "r" } }], { judge });
    expect(g[0]?.id).toBe("wv-judge"); // grader id specified by config.id
  });
});

// ── ONE TABLE, READ BY THE CLASS AND BY THE SETTLE ─────────────────────────────────────────────────────
//
// A built-in's reserved name is owned by its implementation. The control-plane settle cannot see the class —
// it holds the case's `GraderSpec`s — so `BUILTIN_GRADER_OWNED_METRICS` records the same fact, and the classes
// now READ it. This pins the two ends together through the production builder: a class switched back to a
// literal, or a table entry under the wrong id, comes apart here rather than at a runner's first `tests_pass`.
describe("built-in ownership is the contracts table, and makeGraders hands it out unchanged", () => {
  it("every table entry is exactly what makeGraders' grader for that id owns", () => {
    for (const [id, owned] of Object.entries(BUILTIN_GRADER_OWNED_METRICS)) {
      const [g] = makeGraders([{ id }]);
      expect(g?.ownsMetrics, id).toEqual(owned);
    }
  });

  // ⚠️ THE TEST ABOVE ITERATES THE TABLE, SO A CLASS MISSING FROM IT IS INVISIBLE TO IT. That is the direction
  // this defect arrived from: `reward-file` claimed `tests_pass` on its class from a local literal, the
  // in-sandbox producer boundary read the CLASS and let it through, and the settle — which holds only
  // `{ id: "reward-file" }` — found no grant and stamped every verdict `invalid`. Every container task that
  // ships its own tests scored a contract violation instead of a number, on every lane.
  //
  // So this iterates from the CLASS side: whatever `makeGraders` can build, if it claims a RESERVED name, the
  // table the settle reads must grant it that name under that id.
  it("every built-in that CLAIMS a reserved name is granted it by the table the settle reads", () => {
    const builtIns = [
      "tests-pass",
      "command",
      "script-score",
      "script",
      "reward-file",
      "swe-bench",
      "world-state",
      "steps",
      "cost",
      "latency",
      "dom-contains",
      "url-matches",
      "answer-match",
      "store-state",
      "text-metric",
    ];
    const ungranted: string[] = [];
    for (const id of builtIns) {
      // Enough config for every builder to construct; what is asserted is only what the grader CLAIMS.
      const [g] = makeGraders([
        { id, config: { cmd: "true", language: "python", code: "pass", expected: "x", pattern: "x", metric: "m" } },
      ]);
      for (const metric of g?.ownsMetrics ?? [])
        if (RESERVED_AUTHORITY_METRICS.includes(metric) && !builtInOwnedMetrics(id).includes(metric))
          ungranted.push(`${id} claims '${metric}' and the table grants it nothing`);
    }
    expect(ungranted, "the sandbox would accept these and the settle would call every one of them invalid").toEqual([]);
  });

  it("a custom grader declaring a reserved name owns nothing reserved — the sandbox and the settle agree", () => {
    const [g] = makeGraders([{ id: "command", config: { cmd: "true", metric: "state" }, metrics: [{ id: "state" }] }]);
    expect(g?.ownsMetrics ?? []).not.toContain("state");
  });
});
