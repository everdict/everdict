# Judge input contract — declare, preview, dry-run

**Status: SHIPPED (S1–S5 control plane + MCP, and the judge-registration web UI).** S1 core seam · S2
preview surface · S3 dry-run surface · S4 evidence requirements · S5 span-attribute mapping override; the
web registration form now carries a live preview panel, a "Run once" dry-run button, and a requirement
editor. The artifact/span evidence *channel* (new TraceEvent kinds) is deferred as genuinely demand-driven —
S4's `requires` now measures the need. Related: `docs/judges.md` · `docs/architecture/eval-domain-model.md` (Rubric/criteria
split this builds on) · `docs/architecture/trace-sink.md` (the pull/ingest mapping this generalizes) ·
`docs/architecture/streaming-case-pipeline.md` (`collectDeferredTrace`) · skills `evaluation` / `graders`.

## Why

Judges are **runtime data, not code** (multi-tenant: a user registers a `JudgeSpec`/`RubricSpec`, never
writes an evaluator into the repo). But today a user cannot tell what a judge will *actually see* when they
attach it to a given harness until they run a full scorecard and read the scores. Two structural gaps sit
under that:

1. **Trace → evaluation input is a fixed, lossy narrowing the user can't inspect.** Every observability
   platform maps to `TraceEvent[]` via ONE hardcoded transform (`spansToTraceEvents`,
   `packages/trace/src/sources/trace-source.ts:21`, OTel GenAI conventions + MLflow-native fallbacks). It
   drops **artifacts entirely** (no `artifact`/`attachment`/`download` anywhere in `packages/trace`) and
   **skips structural spans** (Langfuse `SPAN`/`CHAIN`/`AGENT`, LangSmith `chain`/`retriever`, Phoenix
   `CHAIN`/`AGENT` emit nothing). The `TraceEvent` is a 7-kind discriminated union
   (`packages/contracts/src/execution/trace.ts:13`); anything outside that vocabulary is lost at ingest.
2. **Every judge/criterion sees the same full-trace serialization; there is no per-judge input selection.**
   `buildPrompt` (`packages/graders/src/model-judge.ts:71`) inlines `JSON.stringify(trace).slice(0, 6000)`
   for `{trace}`; `{dom}` is present only for a browser snapshot; `useScreenshot` is the one binary knob.
   `JudgeSpec.inputs: ["trace","dom","screenshot"]` (`judge-spec.ts:11`) is a coarse modality switch, not a
   requirement contract — a judge cannot declare "I need tool-call X" or "I need artifact Y", and nothing
   validates that the harness produces what the judge's `promptTemplate` references.

So a user wiring `judge × harness` is flying blind, and the fix must be **runtime-configurable + verifiable
before commit** (a wizard, a zero-cost preview, and a one-case dry-run), built on one clean core.

## The one clean core: `GradeContext` as the convergence unit

All three evidence sources produce the SAME unit — `GradeContext = { case, trace, snapshot, compute?,
baseline? }` (`packages/contracts/src/execution/grader.ts:16`) — and every surface consumes it with **no
branching**. The scoring path is already this shape end-to-end; the only new core is a transport-free
*preview* seam extracted from the existing grader.

```ts
// ── @everdict/graders (pure, no transport, no registry, no I/O) ─────────────────────
// (a) EXTRACT the JudgeInput assembly currently inlined in JudgeGrader.grade (judge.ts:86)
//     into a pure function, so grade() and preview() share ONE assembler → the preview never lies.
export function assembleJudgeInput(
  ctx: GradeContext,
  opts: { rubric?: string; criteria?: JudgeCriterion[]; promptTemplate?: string; useScreenshot?: boolean },
): JudgeInput;                        // { task, trace, dom?, response?, expected?, screenshot?, rubric?, criteria?, promptTemplate? }

// (b) Zero model-call preview: render the exact prompt + per-placeholder evidence coverage.
export function previewJudge(input: JudgeInput): {
  prompt: string;                     // = buildPrompt(input), byte-identical to what the model would receive
  evidence: Record<Placeholder, { present: boolean; chars: number; truncated: boolean }>;
  warnings: string[];                 // "{dom} referenced but snapshot has no DOM"; "trace truncated 12440→6000";
                                      // "inputs:[screenshot] declared but snapshot carries no screenshot"
};

// (c) Requirement coverage: does THIS ctx satisfy the judge's declared needs? (Phase 2 requirement model)
export function assessEvidence(requires: EvidenceRequirement[], ctx: GradeContext): {
  satisfied: EvidenceRequirement[]; missing: EvidenceRequirement[]; warnings: string[];
};
```

`grade()` (`packages/graders/src/judge.ts:86`) is then re-expressed as `assembleJudgeInput` → transport →
`parseVerdict`, so **preview and real scoring provably share the input assembler**. Rubric-ref resolution
(inline string vs `{id,version}` registry lookup) stays in the control plane — the existing
`defaultJudgeRunner` `resolveRubric` (`apps/api/src/core/execution/judge-runner.ts`) — so the pure core takes
the *already-resolved* effective rubric/criteria and never touches a registry.

**The one-shot run is already built.** `JudgeRunner.run(spec, tenant, ctx, placement) → Score[]`
(`packages/application-control/src/ports/judge-runner.ts:7`, impl `judge-runner.ts:122`) is the complete
`spec → GradeContext → Score[]` path with tenant-key resolution and visible `skip` reasons. The dry-run
surface is a route + an evidence loader over the EXISTING runner — no new scoring code.

## Three evidence sources → one `GradeContext`

| Source | How the ctx is built | Existing seam | Cost |
| --- | --- | --- | --- |
| **A — re-score a real run/case** | pull a completed `CaseResult` (inline `trace`+`snapshot`, `eval-case.ts:70`) from `RunStore.get(runId).result` or `ScorecardStore.get(id).scorecard.results[i]`; if `traceRef` set, hydrate via `collectDeferredTrace` (`application-control/src/execution/collect-trace.ts:47`) | RunStore/ScorecardStore + collect-trace | 0 (no dispatch) |
| **B — upload/paste a trace** | `TraceEventSchema.array().parse(body.trace)` + synthetic snapshot `{ kind:"prompt", output:"" }` (`environment.ts:27`) | contracts schemas | 0 |
| **C — live one-case dispatch** | `executeCase(deps, owner, job) → CaseResult` (`application-control/src/execution/execute-case.ts:77`), then take `result.trace`/`result.snapshot` | executeCase | 1 case run |

Source A is the most honest (real harness output) and the default; B unblocks "no run yet"; C is the
heavyweight full round-trip. All three hand the same `GradeContext` to preview / coverage / dry-run.

## Three surfaces (thin over the core; BFF↔MCP parity)

- **Wizard** — editing `RubricSpec.promptTemplate`/`criteria` re-renders `previewJudge` per keystroke with
  unfilled placeholders flagged red and `assessEvidence.missing` shown as blockers. Structurally the
  benchmark import wizard's `previewSource` (no-registration preview, `benchmark-service.ts:195`) applied to
  judges.
- **`POST /judges/preview`** — body = `{ spec, rubric?, evidence: {source:"A|B|C", …} }` → `previewJudge` +
  `assessEvidence`. **No model call, no auth to a provider.** Pure, cheap, safe to call live.
- **`POST /judges/:id/try`** (or `/judges/try` for an unregistered draft spec) — resolve the evidence source
  → `GradeContext` → `JudgeRunner.run` → `{ scores, prompt, verdictRaw }`. One model call, one case.
  Reuses the scoring path verbatim (eval-through-everdict — never re-derive dispatch/grade by hand).

Both surfaces are one service function with two transports in the `judge` resource slice
(`api/judge/judge.routes.ts` + `judge.mcp.ts`), per the parity rule.

## Requirement declaration + ingest generalization (Phase 2)

Preview over today's evidence model already exposes the gaps; the requirement contract makes them
*declarative and enforced*, and its `missing[]` prioritizes the ingest work.

```ts
// A judge/rubric declares what evidence it needs — beyond the coarse inputs:[trace,dom,screenshot].
const EvidenceRequirementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: "final_answer" }),                              // an assistant final message must exist
  z.object({ kind: "tool_call", name: z.string().optional() }),   // ≥1 tool_call (optionally named)
  z.object({ kind: "artifact", role: z.string().optional() }),    // a produced artifact (Phase-2 channel)
  z.object({ kind: "span", name: z.string() }),                   // a structural span preserved through ingest
  z.object({ kind: "screenshot" }), z.object({ kind: "dom" }),
]);
JudgeSpecSchema.requires?: EvidenceRequirement[];   // assessEvidence checks ctx against this
```

Satisfying `artifact`/`span` requirements forces the ingest side to stop discarding them — the generalization
the fixed `spansToTraceEvents` waist blocks today:

- **Artifact 1st-class channel** — add an `artifact` `TraceEvent` kind (or `EnvSnapshot.artifacts[]`) carrying
  a `ref` + lazy fetch, so MLflow/OTel attachments survive ingest and reach a judge as selectable evidence.
- **Structural-span preservation / projection** — stop silently dropping non-LLM/non-tool spans; keep them
  addressable so a `span`-requirement judge can see retriever/chain output.
- **Per-harness attr-key mapping override** — realize the "keys are adjustable" comment
  (`trace-source.ts:20`) by wiring a mapping onto `TraceSourceConfig`
  (`packages/contracts/src/execution/trace-source.ts:11`, currently no such field), so a harness that doesn't
  emit OTel GenAI conventions can still map its spans to `TraceEvent`s.

Preview's `warnings`/`missing` become the data that justifies which of these to build first — we do not
pre-build ingest generality that no registered judge requires (no-hypothetical-surface rule).

## Slices (each independently shippable)

| Slice | Contents | Status |
| --- | --- | --- |
| **S1 core seam** | Extract `assembleJudgeInput` from `JudgeGrader.grade`; add pure `previewJudge` (reusing `buildPrompt`); re-express `grade()` over the assembler. Unit tests with fabricated `GradeContext`. No schema/DB/route change. (`assessEvidence` moved to S4 with its schema.) | ✅ `16c97156` |
| **S2 preview surface** | `POST /judges/preview` + MCP `preview_judge` (both over the S1 core). Evidence **source B** (paste a trace). Rubric-ref resolution reused from the runner (`resolveRubric` exported). Gate `judges:read`. | ✅ `6653f259` |
| **S3 dry-run surface** | `POST /judges/try` + MCP `try_judge`, over the EXISTING `JudgeRunner.run`. Evidence loader for **source A** (a prior run's stored `CaseResult` by `runId`) joins source B; a live round-trip is `POST /runs` → try source "run" (no redundant sync-dispatch path). Gate `scorecards:run`. | ✅ `8e412574` |
| **S4 requirement declaration** | `JudgeSpec.requires: EvidenceRequirement[]` + pure `assessEvidence` (in graders); preview/dry-run surface the satisfied/missing split. `final_answer`/`tool_call`/`dom`/`screenshot` decidable today; `artifact`/`span` read as unmet with a reason → the ingest signal. | ✅ `ba66ef05` |
| **S5 ingest generalization** | The demand-justified piece: `SpanAttrMapping` on `TraceSourceConfig`/`TraceSourceSpec`/`CommandTraceSpec`/`TraceRef` → `spansToTraceEvents(spans, mapping)` (keys tried first, GenAI defaults fallback). Realizes the "keys are adjustable" comment. The artifact/span *channel* (new TraceEvent kinds) stays deferred (high blast radius; not yet demanded by a real judge). | ✅ `464f9336` |

**Web UI (shipped):** the judge registration form (`features/register-judge`) carries a live preview panel
(paste a trace → exact prompt + evidence-coverage chips + warnings), a "Run once" dry-run button (real
scores over `POST /judges/try`), and a requirement editor (`JudgeSpec.requires` → satisfied/missing badges).
The per-harness `SpanAttrMapping` editor on the harness form is the remaining UI (the field is registrable
via API/MCP today).

## Back-compat invariants

- `previewJudge` with no custom template renders byte-identically to the default `buildPrompt` (the pure
  extraction changes no output — the S1 assembler refactor is behavior-preserving, guarded by the judge
  grader's existing unit tests).
- `JudgeSpec.requires` is optional; absent ⇒ today's coarse `inputs` behavior, no coverage blockers.
- Preview/dry-run are **additive read/try surfaces** — they never mutate a registered judge or a stored run.
- Adding an `artifact` `TraceEvent` kind is a union widening; existing graders that switch on `kind` ignore it.

## Non-goals

- No new scoring engine — the dry-run is the existing `JudgeRunner.run`; only evidence loading + a route are new.
- No per-criterion evidence *projection* in v1 (every criterion still sees the assembled input); `requires`
  declares *presence*, not per-criterion input slicing. Revisit only if a real judge needs it.
- No speculative ingest generality — artifact/span/mapping work is pulled by S4's observed `missing[]`, not built ahead.
- No preview of harness-judge agent *internals* — a harness judge's own trace stays opaque; preview covers the input handed to it.
