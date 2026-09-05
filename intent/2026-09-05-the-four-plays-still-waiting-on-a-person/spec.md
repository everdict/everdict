From: intent.md @ 9d3afe4192b1bf6be0ea3f6626a037af6a42c7dd
Policies: 30b860799cf6114dbf41226b839921349b859fe4

<!-- Written by `pnpm design` from intent.md, model sonnet, 2026-09-04T22:09:18.011Z.
     A machine proposed this. It is in the working tree and committed by nobody; read it before a plan is
     written against it, and edit it freely — the intent chain applies to this file exactly as to a person's. -->

## Requirements

### 1 — The design pass gets a rotation (accepted intent → spec.md)

1.1. A new script `scripts/design/run.mjs` (pnpm script `design`) selects, from `intent/*/`, the directories whose `intent.md` has `Status: accepted` and carry no `spec.md`, and runs a **read-only** Claude session (`--allowedTools Read,Grep,Glob`, `--disallowedTools Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch` — same posture as `watch.mjs`'s 2σ tier and `triage.mjs`) over the chosen intent, prompted to do exactly what this task's own instructions did: read `CLAUDE.md`, the rules under `.claude/rules/` whose `paths:` glob covers the intent's "Affected users and systems", the skills for the areas involved, and produce the four sections `## Requirements` / `## Design` / `## Areas of concern` / `## Open questions carried forward`.

1.2. The script itself — not the model — writes the returned text to `intent/<dir>/spec.md` in the working tree, and commits nothing. No git command runs inside it.

1.3. `--status` lists every accepted intent with no spec and when (if ever) a design pass last ran over it; `--next` (no arguments = needs no decision) picks the least-recently-attempted one, preferring never-attempted, exactly the selection rule `scripts/scan/run.mjs --next` already uses. `--intent <dir>` targets one explicitly.

1.4. A ledger `.git/everdict-design-log.jsonl` records one line per attempt (`{at, intent, model, wrote, head}`), the same shape `everdict-scan-log.jsonl` uses, so `--status` has a real answer instead of re-deriving it from file mtimes.

1.5. `intent/SPEC-TEMPLATE.md` is added, declaring the four sections above, mirroring `TEMPLATE.md`/`PLAN-TEMPLATE.md`.

1.6. `scripts/check-intent-chain.mjs` is extended: when `spec.md` exists it is held to the same ordering rule `plan.md` already gets — a `From: intent.md @ <sha>` line naming the commit that introduced `intent.md`, and `spec.md`'s own introducing commit must descend from it. This is a `violations` entry (fails the gate) exactly like the existing `plan.md` checks.

1.7. When `spec.md` is **absent** for an intent whose `Status: accepted`, the check pushes to the existing `notes` array (`console.log("· ...")`, no exit-1) — never to `violations`. This is the literal shape of "REPORTED, never failed": the check already has a non-failing channel, so this is an extension of existing code, not a new mechanism.

1.8. `pnpm design` is added to `.claude/rules/ci.md`'s bullet list (required by `pnpm controls-documented`, which fails any `package.json` script that runs `node scripts/**` and isn't named there or in `DECLARED`).

### 2 — Telemetry is on by default

2.1. `.claude/settings.json` gains a top-level `env` block setting `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_METRIC_EXPORT_INTERVAL` — the exact recipe `scripts/telemetry/README.md` currently asks a person to export by hand.

2.2. `OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_ASSISTANT_RESPONSES` / `OTEL_LOG_RAW_API_BODIES` are **not** set — conversation content stays off, unchanged from today.

2.3. `scripts/telemetry/README.md`'s "Owed" section is rewritten: the debt it names ("nothing forces the recipe on") is paid by this change; the recipe block becomes "what `.claude/settings.json` already sets" rather than "what to export by hand" (kept for anyone running the CLI outside this repo's settings).

2.4. `.claude/rules/ci.md`'s telemetry bullet (under the `pnpm watch-bands`/`pnpm triage` entry, which references "the recipe in `scripts/telemetry/README.md`") is updated to say the export is default-on, not opt-in.

### 3 — Bands are read on every full gate run

3.1. `scripts/ci-local.mjs` runs `node scripts/bands/watch.mjs --dry-run` as a step. It never fails the gate (bands are diagnostic, not a pass/fail control) and never blocks on a model call — `--dry-run` is exactly the mode that turns the 2σ/3σ actions into printed lines (`(dry run) would open …` / `(dry run) would file …`) instead of `spawnSync("claude", …)` or a file write, so cost and duration stay fixed regardless of tier.

3.2. This step's placement in `ci-local.mjs` is documented in `.claude/rules/ci.md` next to the existing `watch-bands`/`triage` bullet, naming it as a **visibility** step, not an action step (see Areas of concern §1).

### 4 — A red bespoke gate explains itself

4.1. In `scripts/ci-local.mjs`'s `run()` failure path, before calling `process.exit(1)`, if the failing step corresponds to a `scripts/check-*.mjs` script, the script resolves that script's real filename (not the pnpm alias — see Areas of concern §3) and spawns `pnpm triage <gate>` with `stdio: "inherit"`, printing the diagnosis inline, before exiting 1.

4.2. Steps with no matching `check-*.mjs` (`lint`, `typecheck`, `test`, `build`, `web lint`, `web build`, gitleaks, `empty-env-boot`) are unaffected — triage only applies to the bespoke scanners it already knows how to read.

4.3. This costs one extra `pnpm triage` invocation (a `claude -p` call) **only when a bespoke gate is already red**, matching the existing cost rule stated for `triage` itself.

### 5 — Documentation stays truthful (`pnpm docs-check` / `pnpm controls-documented` / `pnpm convention-harness`)

5.1. `CLAUDE.md`'s "harness's own directories" line is updated to add `scripts/design/` alongside `scripts/bands/`, `scripts/scan/`, `scripts/telemetry/`.

5.2. `intent/README.md` is updated: `spec.md`'s row gains "template: `SPEC-TEMPLATE.md`", and a line describing `pnpm design --next` as how a spec gets written.

5.3. Every new path this spec introduces (`scripts/design/run.mjs`, `intent/SPEC-TEMPLATE.md`) must exist for real once implemented, or `pnpm docs-check` fails on the citations added in 5.1/5.2.

## Design

**Packages/scripts touched** — this is entirely `scripts/`, `.claude/`, `intent/`, `package.json`; no `packages/**` or `apps/**` code, so this change does **not** cross the layer spine and does **not** trigger `pnpm review`'s packages/apps gate.

**New surface:**
- `scripts/design/run.mjs` — same shape as `scripts/scan/run.mjs` and `scripts/bands/watch.mjs`: a CLI with `--status` / `--next` / `--intent <dir>`, a JSONL ledger under `.git/`, a `spawnSync("claude", …)` call with a locked-down tool list, and the script (never the model) doing the filesystem write. **No new glob-matching code**: rather than reimplementing `check-convention-harness.mjs`'s rule-path matcher (which is script-local, not a library, and importing a `check-*.mjs` script *runs* it per the standing "PARSES, does not import" warning), the design pass hands the model `Read`/`Grep`/`Glob` and the same instruction this very task received — find the relevant rules and skills yourself. That is the one clean way to avoid a second copy of a predicate that has already diverged once in this repo's history (`controls-documented`'s own origin story).
- `intent/SPEC-TEMPLATE.md` — new artifact-shape file, referenced by `intent/README.md` and enforced by `check-intent-chain.mjs`.

**Modified surface:**
- `scripts/check-intent-chain.mjs` — one new failing-check block (spec ordering, modeled on the existing plan block) and one new non-failing `notes` push (missing spec on an accepted intent).
- `scripts/ci-local.mjs` — two additions: a `watch.mjs --dry-run` step (Requirement 3) and a triage-on-failure hook inside `run()` (Requirement 4). Both are read/diagnose-only; neither writes to the working tree or git.
- `.claude/settings.json` — an `env` block, additive to the existing `permissions`/`hooks` keys.
- `.claude/rules/ci.md`, `scripts/telemetry/README.md`, `intent/README.md`, `CLAUDE.md` — prose updates keeping the "conventions know about the control" invariant `controls-documented`/`docs-check` enforce.

**Boundary that matters most:** every model-driven step here (`design`, `watch-bands`'s 2σ/3σ tiers, `triage`) runs **locally**, spawning the `claude` CLI as a subprocess that uses the developer's existing login — none of it runs inside GitHub Actions, which has no `ANTHROPIC_API_KEY` (confirmed: no such secret or `claude` CLI setup anywhere in `.github/workflows/`, matching how `pnpm agent-evals` is already scoped to the push gate only). This is why Requirement 3 embeds `watch-bands` in `ci-local.mjs` (a script every push already runs locally) rather than in `ci.yml`.

## Areas of concern

1. **The intent's proposed fix for "nothing invokes the watcher" is visibility, not autonomy, and the gap is real.** `--dry-run` (Requirement 3) makes `watch-bands` print its tier classification on every push, but the 2σ diagnosis and 3σ `intent.md` filing — the two actions that actually "return to the queue on its own" — never fire from inside `ci-local.mjs`, because either one is a real model call and "must not become slower or more expensive for a green run" is stated unconditionally, not "on average." So the closed loop the Problem section describes is only half closed: a person still has to notice the printed line and run `pnpm watch-bands` (no `--dry-run`) to get the actual action. This is a defensible reading of the stated constraint, but it is worth being explicit that it does not fully solve the diagnosed failure mode — it makes the miss much louder, not impossible. The intent's own open question ("triggered by commit vs rotation… tried on a stage rather than a scan") gestures at exactly this tension without resolving it; I did not find a way to resolve it further without either violating the cost constraint or moving the action off the push path entirely (e.g., a developer-run periodic `pnpm watch-bands`, no different in kind from today's manual `pnpm scan`). Flagging for a maintainer call rather than guessing.

2. **Telemetry-by-default reaches every headless `claude -p …--output-format json` subprocess this repo already spawns** (`watch.mjs`'s 2σ tier, `triage.mjs`, and the new `design/run.mjs`), not just interactive sessions. The measured "157 bytes of unrelated stderr" in the intent's constraints doesn't say which mode was measured. `res.stdout` is `JSON.parse`d verbatim in all three scripts; if the exporter ever writes to stdout instead of stderr (even a warning line), that silently breaks parsing rather than failing loudly — a case the surrounding code doesn't currently guard (`triage.mjs` and `watch.mjs` both do a bare `JSON.parse(res.stdout)` in a `try` that reports "unparseable envelope" only, with no distinction from "telemetry noise corrupted it"). Recommend re-measuring specifically against a `claude -p --output-format json` invocation before flipping the default, not just an interactive one.

3. **`triage`'s gate-name convention (`check-<gate>.mjs`) does not match the pnpm script name for two existing gates**: `pnpm cone` → `scripts/check-job-runner-cone.mjs` (gate name `job-runner-cone`, not `cone`), and `pnpm docs-check` → `scripts/check-docs.mjs` (gate name `docs`, not `docs-check`). A naive Requirement-4 implementation that passes `ci-local.mjs`'s own `run()` argument straight to `pnpm triage <name>` will, for these two, print `✖ triage: no scripts/check-cone.mjs` / `no scripts/check-docs-check.mjs` instead of a real diagnosis — silently defeating the feature for exactly the gates a developer is least likely to know the filename convention for. The fix (a small alias table, or deriving the gate name from `package.json`'s own command string rather than the script alias) needs to be part of the implementation, not discovered by someone hitting it live.

4. **The chain semantics get a third node and the intent only defines two of the three edges.** `spec.md`'s relationship to `intent.md` is specified (Requirement 1.6, mirrors `plan.md`). `plan.md`'s relationship to `spec.md`, when both exist, is not addressed anywhere in the intent — does a `plan.md` written after a design pass need to cite `spec.md` too, or does it keep citing only `intent.md` as it does for all nine existing plans? I've scoped this spec to leave `plan.md`'s existing rule untouched (no forced retrofit of nine committed plans), but this is a real design gap the plan-writer should resolve explicitly rather than inherit by omission.

5. **`.claude/settings.json`'s `env` block is global, not scoped to "the maintainer's local recipe."** It will apply to every session anyone runs against this checkout, including any future automation that happens to invoke the `claude` CLI in an environment where `127.0.0.1:4318` is reachable but unexpected (a sandboxed CI runner, a hosted agent session). Given the measured noise is small and content-free, this is likely fine, but it's a step beyond "the maintainer's own habit" into "everyone's default," and that widening isn't discussed in the intent's Constraints.

## Open questions carried forward

- **From the intent, unresolved by this spec:** "Should the design pass be triggered by the commit that accepts an intent rather than by a rotation?" — I did not choose a hook-on-accept design; Requirement 1 implements the rotation as stated, wired into `ci-local.mjs` for **selection visibility only** (Requirement 1.3's `--status`), with the actual write (1.1/1.2) remaining a separately-invoked `pnpm design --next`, for the same cost reason `watch-bands`'s real action stays out of the push path (Area of concern §1). A commit-on-accept hook would resolve the "still needs a person" gap Area of concern §1 names, at the tax-on-every-commit cost the intent explicitly weighed against.
- **New, raised by this pass:** does `plan.md` need to cite `spec.md` when one exists (Area of concern §4)? Needs a decision before `check-intent-chain.mjs`'s extension is implemented, not after.
- **New, raised by this pass:** is the "157 bytes of unrelated stderr" measurement valid for the headless `--output-format json` path specifically (Area of concern §2)? Should be re-checked before Requirement 2 ships, since three existing scripts (`watch.mjs`, `triage.mjs`, and the new `design/run.mjs`) depend on `res.stdout` being clean JSON.
