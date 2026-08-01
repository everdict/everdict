import { describe, expect, it } from "vitest";
import {
  DashboardSpecSchema,
  HtmlSpecSchema,
  findHtmlStyleViolations,
  parseAnalysisArtifactSpec,
} from "./analysis-artifact.js";

// The artifact frame injects the workspace's live theme tokens, so agent-authored markup must COMPOSE from the
// design system rather than invent one. These are the checks that keep a generated dashboard from reading as a
// foreign widget: a literal color cannot follow the member's light/dark theme.

describe("agent-authored html artifact design conformance", () => {
  it("accepts markup that takes its colors from the injected theme tokens", () => {
    const html =
      '<div class="grid"><div class="metric"><span class="metric-label">Pass rate</span>' +
      '<span class="metric-value">60%</span><span class="delta up">▲ 4.2pt</span></div></div>' +
      "<style>.metric-value{color:var(--foreground)}.bar{background:var(--chart-1)}</style>";
    expect(findHtmlStyleViolations(html)).toEqual([]);
    expect(HtmlSpecSchema.parse({ html })).toMatchObject({ html });
  });

  it("rejects a hardcoded hex color and names the tokens to use instead", () => {
    const violations = findHtmlStyleViolations("<style>.up{color:#22c55e}</style>");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("#22c55e");
    expect(violations[0]).toContain("var(--chart-1)");
  });

  it("rejects rgb()/hsl() literals but allows color-mix over a token", () => {
    expect(findHtmlStyleViolations("<b style='color:rgb(34,197,94)'>x</b>")).toHaveLength(1);
    expect(
      findHtmlStyleViolations("<style>.chip{background:color-mix(in oklab, var(--success) 12%, transparent)}</style>"),
    ).toEqual([]);
  });

  it("rejects gradients, author-set type and named paint colors", () => {
    expect(
      findHtmlStyleViolations("<style>.h{background:linear-gradient(90deg,var(--a),var(--b))}</style>"),
    ).toHaveLength(1);
    expect(findHtmlStyleViolations("<style>body{font-family:Inter,sans-serif}</style>")).toHaveLength(1);
    expect(findHtmlStyleViolations('<rect fill="white" />')).toHaveLength(1);
  });

  it("rejects emoji so the dashboard keeps the product's own vocabulary", () => {
    const violations = findHtmlStyleViolations("<p>Pass rate up 🚀</p>");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("▲");
  });

  it("does not mistake inline-SVG fragment references for hardcoded colors", () => {
    // `url(#…)` and `href="#…"` are how an SVG chart references its own defs — hex-like, but structural.
    const html = '<svg><defs><clipPath id="cafe"/></defs><rect clip-path="url(#cafe)" fill="var(--chart-2)"/></svg>';
    expect(findHtmlStyleViolations(html)).toEqual([]);
  });

  it("blocks a non-conformant spec at the emission gate, not just at the tool boundary", () => {
    expect(() => parseAnalysisArtifactSpec("html", { html: "<b style='color:#fff'>60%</b>" })).toThrow();
  });
});

// A gate that bounces LEGITIMATE markup is worse than no gate: the model is ordered to "fix" something that was
// never wrong, and an unattended report turn burns its budget doing it. Colors are therefore only read where a
// color can be authored, and these are the shapes an eval dashboard genuinely contains.
describe("design conformance leaves the dashboard's DATA alone", () => {
  const dataShapes: [string, string][] = [
    ["an issue reference", "<td>django__django-11099 (case #4521)</td>"],
    ["a commit reference", '<span class="metric-sub">baseline at #a8d39b</span>'],
    ["a pull-request number", '<p class="muted">merged in #1234</p>'],
    ["a rank", "<td>#2</td>"],
    ["color words in row values", "<td>redis</td><td>greenfield-01</td><td>Blue team</td>"],
    ["currentColor on an icon", '<svg><path fill="currentColor"/></svg>'],
    ["stroke geometry on a chart", '<line stroke="var(--border)" stroke-width="1" stroke-dasharray="2 2"/>'],
    ["hex-like ids in SVG defs", '<svg><defs><linearGradient id="abc123"/></defs><rect fill="url(#abc123)"/></svg>'],
  ];
  for (const [what, html] of dataShapes)
    it(`accepts ${what}`, () => {
      expect(findHtmlStyleViolations(html)).toEqual([]);
    });

  it("still catches the same literal once it moves into a styling region", () => {
    // The proof that the scoping is about WHERE the value sits, not about weakening the rule.
    expect(findHtmlStyleViolations("<td>case #4521</td>")).toEqual([]);
    expect(findHtmlStyleViolations('<td style="color:#4521aa">case</td>')).toHaveLength(1);
  });
});

// What an unconstrained model reaches for, and whether the refusal actually teaches it the way out.
describe("design conformance against the output the gate exists to stop", () => {
  const SLOP = [
    '<div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:16px;padding:24px">',
    '<h2 style="font-family:Inter,sans-serif;color:#ffffff">📊 Eval Dashboard 🚀</h2>',
    '<div style="color:#22c55e">▲ 4.2pt</div><div style="color:rgb(239,68,68)">▼ 17.8%</div>',
    "</div>",
  ].join("");

  it("refuses it, and every refusal names a token to use instead", () => {
    const violations = findHtmlStyleViolations(SLOP);
    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.join(" ")).toContain("var(--chart-1)");
  });

  it("accepts the same dashboard once each refusal is followed literally", () => {
    // Gradient → .panel · authored type → dropped · hex/rgb deltas → .delta chips · emoji → removed.
    const corrected = [
      '<div class="panel">',
      "<h2>Eval Dashboard</h2>",
      '<div class="delta up">▲ 4.2pt</div><div class="delta down">▼ 17.8%</div>',
      "</div>",
    ].join("");
    expect(findHtmlStyleViolations(corrected)).toEqual([]);
  });

  it("keeps the refusal small enough for an unattended turn to absorb", () => {
    // The report turn is budget-capped, so a rejection must cost a short correction, not a wall of text.
    const parsed = HtmlSpecSchema.safeParse({ html: SLOP });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.length).toBeLessThanOrEqual(4);
    expect(parsed.error.message.length).toBeLessThan(4_000);
  });
});

// The structured dashboard is the kind that needs no design gate — it has no vocabulary for a color, a size or
// a font. What it MUST enforce instead is that the semantics are complete: a metric without its meaning is
// what makes the rendered card wrong rather than ugly.
describe("structured dashboard spec", () => {
  const metrics = {
    type: "metrics" as const,
    metrics: [
      { label: "Pass rate", value: 0.624, unit: "ratio" as const, baseline: 0.582 },
      { label: "Cost / case", value: 0.284, unit: "usd" as const, baseline: 0.241, higherIsBetter: false },
    ],
  };

  it("accepts a dashboard composed of the kinds we already render", () => {
    const spec = {
      blocks: [
        metrics,
        { type: "chart", title: "By suite", chart: { type: "bar", x: ["a"], series: [{ label: "s", points: [1] }] } },
        { type: "table", table: { columns: ["case"], rows: [["c1"]] } },
        { type: "note", markdown: "Cost rose with the retry change." },
      ],
    };
    expect(DashboardSpecSchema.parse(spec).blocks).toHaveLength(4);
    expect(parseAnalysisArtifactSpec("dashboard", spec)).toBeTruthy();
  });

  it("refuses a block that names a type it does not carry the data for", () => {
    expect(() =>
      DashboardSpecSchema.parse({ blocks: [{ type: "chart", table: { columns: [], rows: [] } }] }),
    ).toThrow();
    expect(() => DashboardSpecSchema.parse({ blocks: [{ type: "metrics", metrics: [] }] })).toThrow();
    expect(() => DashboardSpecSchema.parse({ blocks: [] })).toThrow();
  });

  it("refuses a metric with no value to show", () => {
    expect(() =>
      DashboardSpecSchema.parse({ blocks: [{ type: "metrics", metrics: [{ label: "Pass rate" }] }] }),
    ).toThrow();
  });

  it("has no way to express a color, a size or a font — the reason it needs no design gate", () => {
    const spec = DashboardSpecSchema.parse({ blocks: [metrics] });
    // Every leaf is a label, a number or a boolean. A model cannot smuggle presentation through it, so unlike
    // the `html` kind there is nothing here to police.
    expect(JSON.stringify(spec)).not.toMatch(/color|font|style|px|#[0-9a-f]{3}/i);
  });
});
