import { describe, expect, it, vi } from "vitest";
import { extractEvidence, fetchImageBase64 } from "./evidence-resolve.js";
import { MlflowTraceSource } from "./mlflow.js";
import {
  type Span,
  classifyScreenshotValue,
  spansToEvidence,
  spansToTraceEvents,
  withEvidenceEvents,
} from "./trace-source.js";

// A tiny valid-looking base64 PNG payload (long enough to pass the bare-base64 heuristic).
const BARE_BASE64 = "iVBORw0KGgoAAAANSUhEUg".repeat(16);

const SPANS: Span[] = [
  {
    name: "step-1",
    startMs: 0,
    endMs: 10,
    attrs: { "agent.answer": "working on it", "agent.dom": "<p>start</p>" },
  },
  {
    name: "step-2",
    startMs: 20,
    endMs: 30,
    attrs: { "agent.answer": "the booking is confirmed", "agent.dom": "<p>done</p>", "agent.shot": BARE_BASE64 },
  },
];

describe("spansToEvidence (mapping evidence slots)", () => {
  it("extracts the LAST defined value per slot (= the final state)", () => {
    const evidence = spansToEvidence(SPANS, {
      finalAnswer: ["agent.answer"],
      dom: ["agent.dom"],
      screenshot: ["agent.shot"],
    });
    expect(evidence?.finalAnswer).toBe("the booking is confirmed");
    expect(evidence?.dom).toBe("<p>done</p>");
    expect(evidence?.screenshot).toBe(BARE_BASE64); // bare base64 → inline bytes
    expect(evidence?.screenshotMediaType).toBe("image/png");
    expect(evidence?.screenshotRef).toBeUndefined();
  });

  it("no evidence slots in the mapping → undefined (explicit-mapping only, nothing guessed)", () => {
    expect(spansToEvidence(SPANS, { model: ["x"] })).toBeUndefined();
    expect(spansToEvidence(SPANS, undefined)).toBeUndefined();
  });

  it("slots mapped but no attr present → undefined (no empty evidence object)", () => {
    expect(spansToEvidence(SPANS, { finalAnswer: ["nope"] })).toBeUndefined();
  });
});

describe("classifyScreenshotValue", () => {
  it("data-URI → inline bytes with its declared media type", () => {
    const v = classifyScreenshotValue(`data:image/jpeg;base64,${BARE_BASE64}`);
    expect(v).toEqual({ base64: BARE_BASE64, mediaType: "image/jpeg" });
  });
  it("short non-base64 string → a fetchable ref", () => {
    expect(classifyScreenshotValue("https://mlflow/artifacts/shot.png")).toEqual({
      ref: "https://mlflow/artifacts/shot.png",
    });
  });
});

describe("withEvidenceEvents", () => {
  it("appends the final answer as a trailing assistant message", () => {
    const events = spansToTraceEvents(SPANS);
    const out = withEvidenceEvents(events, { finalAnswer: "the booking is confirmed" });
    const last = out[out.length - 1];
    expect(last).toMatchObject({ kind: "message", role: "assistant", text: "the booking is confirmed" });
    expect(out.length).toBe(events.length + 1);
  });

  it("does not duplicate when the timeline already ends with the same assistant text", () => {
    const events = spansToTraceEvents(SPANS, { messageText: ["agent.answer"] });
    const out = withEvidenceEvents(events, { finalAnswer: "the booking is confirmed" });
    expect(out).toEqual(events);
  });
});

describe("spansToEvidence — selectors (path into JSON + custom slots)", () => {
  const JSON_SPANS: Span[] = [
    {
      name: "agent",
      startMs: 0,
      endMs: 10,
      attrs: {
        // an OBJECT attr (mlflow kvlist-flattened) and a JSON-STRING attr — both must be path-addressable
        "mlflow.spanOutputs": { final_answer: "booked", steps: [{ action: "login" }, { action: "search" }] },
        "agent.result": '{"confirmation": {"id": "R-42"}}',
      },
    },
  ];

  it("path reaches inside an object attr and a JSON-string attr (dot/bracket)", () => {
    const evidence = spansToEvidence(JSON_SPANS, {
      finalAnswer: [{ key: "mlflow.spanOutputs", path: "final_answer" }],
      evidence: {
        second_step: [{ key: "mlflow.spanOutputs", path: "steps[1].action" }],
        confirmation_id: [{ key: "agent.result", path: "confirmation.id" }],
      },
    });
    expect(evidence?.finalAnswer).toBe("booked");
    expect(evidence?.custom).toEqual({ second_step: "search", confirmation_id: "R-42" });
  });

  it("a pathless selector on an object attr yields the whole value as JSON text", () => {
    const evidence = spansToEvidence(JSON_SPANS, {
      evidence: { raw_output: [{ key: "mlflow.spanOutputs", path: "confirmation_missing" }, "agent.result"] },
    });
    // selector-major: the first selector resolves nothing (bad path) → the next selector (whole value) wins
    expect(evidence?.custom?.raw_output).toBe('{"confirmation": {"id": "R-42"}}');
  });

  it("pick:first takes the earliest span's occurrence (default stays last)", () => {
    const spans: Span[] = [
      { name: "a", startMs: 0, endMs: 1, attrs: { v: "early" } },
      { name: "b", startMs: 5, endMs: 6, attrs: { v: "late" } },
    ];
    expect(spansToEvidence(spans, { evidence: { x: [{ key: "v", pick: "first" }] } })?.custom?.x).toBe("early");
    expect(spansToEvidence(spans, { evidence: { x: [{ key: "v" }] } })?.custom?.x).toBe("late");
  });
});

describe("extractEvidence — URL artifact auto-fetch (same-origin credential guard)", () => {
  const spans: Span[] = [
    {
      name: "s",
      startMs: 0,
      endMs: 1,
      attrs: {
        "agent.dom_ref": "https://mlflow.acme.dev/artifacts/dom.html",
        "agent.log_ref": "https://elsewhere.example.com/run.log",
        "agent.answer": "https://the-answer-is-this-url.example.com",
      },
    },
  ];
  const mapping = {
    dom: ["agent.dom_ref"],
    finalAnswer: ["agent.answer"],
    evidence: { run_log: ["agent.log_ref"] },
  };

  it("resolves URL values to their real text; credentials only travel same-origin; finalAnswer never fetched", async () => {
    const calls: Array<{ url: string; headers: unknown }> = [];
    const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) => {
      calls.push({ url: String(args[0]), headers: (args[1] as RequestInit | undefined)?.headers });
      return Promise.resolve(new Response("REAL CONTENT", { status: 200, headers: { "content-type": "text/plain" } }));
    });
    const evidence = await extractEvidence(
      spans,
      mapping,
      fetchImpl as unknown as typeof fetch,
      { authorization: "Basic zzz" },
      "https://mlflow.acme.dev",
    );
    expect(evidence?.dom).toBe("REAL CONTENT"); // same-origin ref → fetched with credentials
    expect(evidence?.custom?.run_log).toBe("REAL CONTENT"); // cross-origin ref → fetched BARE
    expect(evidence?.finalAnswer).toBe("https://the-answer-is-this-url.example.com"); // the answer is the answer
    const domCall = calls.find((c) => c.url.includes("mlflow.acme.dev"));
    const logCall = calls.find((c) => c.url.includes("elsewhere.example.com"));
    expect(domCall?.headers).toEqual({ authorization: "Basic zzz" });
    expect(logCall?.headers).toBeUndefined();
    expect(calls.some((c) => c.url.includes("the-answer-is-this-url"))).toBe(false);
  });

  it("a failed artifact fetch keeps the URL string (never fails the pull)", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("down")));
    const evidence = await extractEvidence(spans, mapping, failing as unknown as typeof fetch);
    expect(evidence?.dom).toBe("https://mlflow.acme.dev/artifacts/dom.html");
    expect(evidence?.custom?.run_log).toBe("https://elsewhere.example.com/run.log");
  });
});

describe("fetchImageBase64", () => {
  it("resolves an http(s) ref with the source headers; failures return undefined (never throw)", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(png, { status: 200, headers: { "content-type": "image/png" } })),
    );
    const ok = await fetchImageBase64(fetchImpl as unknown as typeof fetch, "https://x/shot.png", { a: "b" });
    expect(ok?.base64).toBe(Buffer.from(png).toString("base64"));
    expect(ok?.mediaType).toBe("image/png");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { a: "b" } });

    const failing = vi.fn(() => Promise.resolve(new Response("nope", { status: 403 })));
    expect(await fetchImageBase64(failing as unknown as typeof fetch, "https://x/shot.png")).toBeUndefined();
    expect(await fetchImageBase64(fetchImpl as unknown as typeof fetch, "s3://bucket/shot.png")).toBeUndefined();
  });
});

describe("extractEvidence (pure extraction + best-effort ref resolution)", () => {
  it("keeps the unresolved ref when the fetch fails — a missing screenshot never fails the pull", async () => {
    const spans: Span[] = [{ name: "s", startMs: 0, endMs: 1, attrs: { "agent.shot": "https://x/gone.png" } }];
    const failing = vi.fn(() => Promise.reject(new Error("boom")));
    const evidence = await extractEvidence(spans, { screenshot: ["agent.shot"] }, failing as unknown as typeof fetch);
    expect(evidence?.screenshotRef).toBe("https://x/gone.png");
    expect(evidence?.screenshot).toBeUndefined();
  });
});

describe("MlflowTraceSource.fetchDetailed (evidence end-to-end)", () => {
  it("returns events + evidence and appends the mapped final answer to the timeline", async () => {
    const trace = {
      trace: {
        spans: [
          {
            name: "agent",
            start_time_unix_nano: 1_000_000,
            end_time_unix_nano: 2_000_000,
            attributes: [
              { key: "agent.answer", value: { string_value: "42" } },
              { key: "agent.dom", value: { string_value: "<html>done</html>" } },
            ],
          },
        ],
      },
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify(trace), { status: 200 })),
    );
    const src = new MlflowTraceSource({
      endpoint: "http://mlflow",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      mapping: { finalAnswer: ["agent.answer"], dom: ["agent.dom"] },
    });
    const detailed = await src.fetchDetailed("tr-1");
    expect(detailed.evidence).toEqual({ finalAnswer: "42", dom: "<html>done</html>" });
    const last = detailed.events[detailed.events.length - 1];
    expect(last).toMatchObject({ kind: "message", role: "assistant", text: "42" });
    // fetch() stays the events view of the same pull.
    expect(await src.fetch("tr-1")).toEqual(detailed.events);
  });
});
