import { z } from "zod";
import { BuildRecipeSchema, SourceRecipeSchema } from "./build-recipe.js";
import type { ComputeHandle } from "./compute.js";

// v1 is repo only. browser/os-use add variants to the union (no core rewrite).
export const RepoSnapshotSchema = z.object({
  kind: z.literal("repo"),
  diff: z.string(),
  changedFiles: z.array(z.string()),
  headSha: z.string(),
});
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;

// Result observation of a browser target environment (DOM/screenshot/URL). screenshotRef = MinIO object ref.
export const BrowserSnapshotSchema = z.object({
  kind: z.literal("browser"),
  url: z.string(),
  dom: z.string(),
  // Object-store ref to the FULL page DOM when it was offloaded (large HTML bloats the persisted record). When set,
  // `dom` holds only an inline preview; the full DOM stays fetchable via this ref. Absent = `dom` is the whole thing.
  domRef: z.string().optional(),
  screenshotRef: z.string().optional(),
  // Embed the final page screenshot PNG as base64 (same shape as os-use) — input for a VLM judge (useScreenshot) + web inline display.
  // Reproduces how the official WebVoyager judges a screenshot with GPT-4V. If absent (not embedded), fall back to a text judge.
  screenshot: z.string().optional(),
  console: z.array(z.string()).default([]),
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;

// Environment-free QA (prompt→answer). There is no result world, so the snapshot is minimal (scoring looks at the answer in the trace — answer-match/judge).
export const PromptSnapshotSchema = z.object({
  kind: z.literal("prompt"),
  output: z.string().default(""), // optional: the agent's final answer (if any). The primary signal is the trace.
});
export type PromptSnapshot = z.infer<typeof PromptSnapshotSchema>;

// Result observation of desktop (OS) computer-use — screen screenshot + window list (OSWorld-style, desktop app automation). Input for a VLM judge.
export const OsUseSnapshotSchema = z.object({
  kind: z.literal("os-use"),
  screenshotRef: z.string().default(""), // path/ref of the captured screenshot (inside the image compute)
  // Embed the screenshot PNG as base64 (the carrier for taking it out of the result, since the compute is disposed). Display (web <img>) + VLM judge input.
  // Dev path: inline in the result record. At scale, offload to object storage (MinIO) + replace with a presigned URL (screenshotRef).
  screenshot: z.string().default(""), // base64 PNG (empty string if absent)
  windows: z.array(z.string()).default([]), // titles of visible windows (if any)
});
export type OsUseSnapshot = z.infer<typeof OsUseSnapshotSchema>;

export const EnvSnapshotSchema = z.discriminatedUnion("kind", [
  RepoSnapshotSchema,
  BrowserSnapshotSchema,
  PromptSnapshotSchema,
  OsUseSnapshotSchema,
]);
export type EnvSnapshot = z.infer<typeof EnvSnapshotSchema>;

// Repo seed source: remote git / inline file map (fixture) / in-image path (a repo already checked out in the container, e.g. SWE-bench /testbed).
// path: use the repo in the image as the working directory without cloning (deps also bundled in the image) — the coding agent works directly on that repo.
export const RepoSourceSchema = z.union([
  // Remote git: as-is if public; if private, reference a workspace external account connection (Connected accounts) by connectionId —
  // the control plane resolves that token at dispatch and loads it transiently into the job (CaseJob.repoToken) for authenticated clone (the token is not stored on the case).
  z.object({ git: z.string().url(), ref: z.string(), connectionId: z.string().optional() }),
  z.object({ files: z.record(z.string()) }),
  z.object({ path: z.string() }),
]);
export type RepoSource = z.infer<typeof RepoSourceSchema>;

export const ConcreteEnvSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo"),
    source: RepoSourceSchema,
    setup: z.array(z.string()).optional(),
  }),
  // Target environment (II): browser. Case seed = start URL. The actual instance is spun up per-case by the TopologyRuntime.
  z.object({
    kind: z.literal("browser"),
    startUrl: z.string().optional(),
  }),
  // Environment-free QA (prompt→answer). No stage like repo/browser — gsm8k/GAIA style. Adds optional context to the task.
  z.object({
    kind: z.literal("prompt"),
    context: z.string().optional(),
  }),
  // Target environment: desktop (OS). The agent looks at the screen and drives GUI apps with mouse/keyboard (OSWorld/computer-use, e.g. hermes-desktop).
  // Runs in a desktop compute image (Xvfb+apps) — setup brings up display/apps, screenshotCmd observes.
  z.object({
    kind: z.literal("os-use"),
    display: z.string().optional(), // X DISPLAY (default ":99")
    setup: z.array(z.string()).optional(), // commands to bring up display/window-manager/apps (Xvfb, wm, desktop app)
    screenshotCmd: z.string().optional(), // screenshot capture command (default scrot). Output path = screenshotPath
    screenshotPath: z.string().optional(), // screenshot save path (default /tmp/everdict-screen.png)
  }),
]);
export type ConcreteEnvSpec = z.infer<typeof ConcreteEnvSpecSchema>;

// ── AN ENVIRONMENT NAMED BY REFERENCE (docs/architecture/harness-definability-spec.md §2) ────────────
//
// A case that EMBEDS its environment can never be evaluated against a second version of that environment:
// changing the seed repository, the fixture or the deployed app rewrites the case, so the delta is filed
// under `dataset_content` and the comparison cannot say which side moved. A ref names a registered
// environment document instead, and the version the batch actually ran is sealed on its own identity axis.
//
// The ref is resolved by the CONTROL PLANE before dispatch (`resolveCaseEnvironment`), so nothing in a
// sandbox ever meets one — `environmentFor` in the job runner refuses this kind by name rather than
// guessing a seed.
export const EnvRefSchema = z.object({
  kind: z.literal("ref"),
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(), // absent = the registry's `latest`, pinned at seal time
});
export type EnvRef = z.infer<typeof EnvRefSchema>;

export const EnvSpecSchema = z.discriminatedUnion("kind", [...ConcreteEnvSpecSchema.options, EnvRefSchema]);
export type EnvSpec = z.infer<typeof EnvSpecSchema>;

// The registered environment document: `(tenant, id, version) → EnvironmentSpec`, immutable per version, the
// same shape every other registry keeps (harness · dataset · judge · runtime). Its `env` is a CONCRETE spec —
// a ref to a ref is a chain no reader resolves, so the type refuses to hold one.
export const EnvironmentSpecSchema = z
  .object({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    env: ConcreteEnvSpecSchema,
    // ── THE WORLD'S BYTES (docs/architecture/world-and-engagement-model.md, axis 1: in-compute) ────────
    //
    // A repo at a commit, a desktop with its apps, a fixture tree — an IN-COMPUTE world is delivered as the
    // container the actor runs in, so its bytes belong to the world rather than to the case that asks a
    // question about it. Until this field existed, a versioned environment could not carry them: `EvalCase.image`
    // owned them, so evolving the world meant editing every case, and an environment build recipe had nowhere
    // to put its output.
    //
    // PRECEDENCE, stated once because a field that means two things is how the next reader gets it wrong: a
    // case that references an environment takes the world's image FROM the environment, and a case that also
    // names its own image for that world is REFUSED (`caseEnvironmentImageDefect`) rather than silently
    // preferring one. A case with no environment reference is untouched — `EvalCase.image` still means what it
    // has always meant there.
    image: z.string().min(1).optional(),
    // ── A PROVIDED WORLD'S COORDINATES (world-and-engagement-model.md, axis 1: provided) ──────────────
    //
    // Some worlds are not the actor's container: a deployed app, a browser, a desktop session. The actor
    // reaches them by COORDINATES, and somebody has to produce those before it runs. `static` is the variant
    // for a world that already exists — the workspace hosts it (a self-hosted WebArena, a staging API) — so
    // there is nothing to bring up and nothing to tear down, and the environment's job is to say WHERE it is
    // under a version somebody can pin.
    //
    // The wiring keys are the vocabulary the topology front door already speaks (`target_base_url`,
    // `target_cdp_url`, …), so a world provided statically and one provided by a session API hand the actor the
    // same names. A DYNAMIC variant — bring-up, teardown, verified zero — is the next slice and is deliberately
    // not declared here: an arm nothing provides is a plan (rule `protocol`).
    provides: z
      .object({
        kind: z.literal("static"),
        wiring: z.record(z.string().min(1), z.string().min(1)),
      })
      .optional(),
    // ── HOW THE WORLD'S BYTES ARE PRODUCED (world-and-engagement-model.md, landing order 3) ────────────
    //
    // The same recipe a harness slot's image is built from — one shape, two subjects, one owner
    // (`execution/build-recipe.ts`). It is what makes an environment EVOLVABLE by building rather than only by
    // pinning: a campaign proposes a change to the world's source, the build lane produces an image, and the
    // minted version is a new world with its own identity. Absent = this world is authored and registered,
    // which is what a harness with no recipe already does.
    //
    // Declaring a recipe with no `image` is refused (`environmentBuildDefects`): a build whose output has
    // nowhere to land is the state this field exists to end.
    source: SourceRecipeSchema.optional(),
    build: BuildRecipeSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    for (const message of environmentBuildDefects(spec))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["build"], message });
  });
export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>;

// The stage for behavior. seed = a known initial state, snapshot = capture the result world.
export interface Environment<S extends EnvSnapshot = EnvSnapshot> {
  readonly kind: S["kind"];
  seed(compute: ComputeHandle, spec: EnvSpec): Promise<void>;
  snapshot(compute: ComputeHandle): Promise<S>;
  // Optional in-run environment sample — the recorder plane, polled by run-case into CaseResult.envDeltas so a run's
  // replay shows how the world evolved (not just the final snapshot). Must be NON-INTRUSIVE (never mutate the agent's
  // state): RepoEnvironment returns a git-diff vs HEAD via a throwaway index. Absent = only the final snapshot is
  // captured. Best-effort — a sampling failure never affects the run. docs/architecture/replay.md (Principle 1).
  // `undefined` = sampled and NOTHING CHANGED (a real answer). A sample that could not be taken THROWS —
  // the recorder owns best-effort and counts the failure, because a swallow here turned every broken sampler
  // into a calmer-looking world (evolution-lineage Track C, sampling_failed).
  sampleDelta?(compute: ComputeHandle): Promise<{ kind: "repo-diff"; text: string } | undefined>;
}

// The refusal above, as a total function, so the resolution and any door that validates a case ask ONE
// question. Empty = no conflict. It is a DEFECT rather than a precedence rule because both readings are
// defensible from the outside — the case author meant to pin the world's bytes, or meant to override the
// actor's container — and a platform that picks one silently decides which experiment ran.
export function caseEnvironmentImageDefect(
  evalCase: { id: string; image?: string; env: { kind: string } },
  environment: { id: string; version: string; image?: string },
): string | undefined {
  if (evalCase.env.kind !== "ref") return undefined;
  if (evalCase.image === undefined || environment.image === undefined) return undefined;
  if (evalCase.image === environment.image) return undefined; // the same bytes, said twice — not a conflict
  return `case '${evalCase.id}' names image '${evalCase.image}' and references environment '${environment.id}@${environment.version}', whose world is '${environment.image}' — the world's bytes belong to the environment, so remove the case's image or stop referencing the environment`;
}

// A recipe that cannot produce a world, refused where the environment enters rather than where a build fails.
// Both halves are needed: a `build` with no `source` has nothing to clone, and a recipe with no `image` on the
// spec has nowhere to put what it produced — which was the exact blocker this field was added to remove.
export function environmentBuildDefects(spec: {
  image?: string;
  source?: unknown;
  build?: unknown;
}): string[] {
  const defects: string[] = [];
  if (spec.build !== undefined && spec.source === undefined)
    defects.push("build declared with no source — there is nothing to clone and build");
  if (spec.build !== undefined && spec.image === undefined)
    defects.push(
      "build declared with no image — a built world needs somewhere to land, and the image is what a case runs",
    );
  return defects;
}
