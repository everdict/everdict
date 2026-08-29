import { type TraceEvent, type TraceSpan, UpstreamError } from "@everdict/contracts";
import { contentDigest, spansToEvents } from "@everdict/domain";
import { type ArtifactStore, artifactKeyOf, artifactRefOf } from "./artifact-store.js";
import {
  MAX_RESOLVED_PAGE_BYTES,
  type SealInput,
  type SealedTrajectory,
  type TrajectoryEventsResult,
  type TrajectoryListResult,
  type TrajectoryMeta,
  type TrajectoryPayloadRef,
  type TrajectoryStore,
  type TrajectoryUsage,
  type TrajectoryWindow,
  clampWindow,
  ownsPayloadKey,
  serializedBytes,
} from "./trajectory-store.js";

// ── ONE EVENT IS BOUNDED, TOO (docs/architecture/long-horizon-trace-reads.md, R1) ────────────────────
//
// The windowed read (R2) bounds how MANY events a page materializes. It cannot bound how LARGE one is, and
// on a long-horizon run the individual events are the other half of the problem: a tool result holding a
// file dump, a `write_file` call's arguments, an OTLP attribute bag carrying a whole completion. A page of
// a hundred events is only a bound if the events are bounded.
//
// `offloadSnapshot` bounded an EnvSnapshot's screenshot and DOM years ago (`DOM_INLINE_MAX`), and the
// `artifact` TraceEvent kind has always been ref-only. This is that same law applied where the bytes
// actually arrive — as a DECORATOR on the seal choke point, for the reason the naming decorator gives:
// there are eight seal paths and only some of them would ever remember.
//
// ── AND RESOLUTION IS ASKED FOR, NEVER AUTOMATIC ──────────────────────────────────────────────────
//
// A read that always put the bytes back would undo the whole thing — the page would be as large as it ever
// was, one indirection later. So the default read serves the PREVIEW plus the ref, which is what a viewer
// wants (it shows an excerpt and a link), and a caller that must have the bytes says so
// (`TrajectoryWindow.resolve`). Judges, re-scores and ingest are that caller: they score the trace, and
// scoring an excerpt is scoring different evidence.
//
// Nothing is discarded either way. This is a MOVE — the record still contains what the agent produced, and
// `resolve` returns exactly the value that was sealed.

// How much of one field stays inline, IN BYTES and for the field AS A WHOLE. Chosen against the two
// truncations that already exist downstream: the model judge renders the whole trace as
// `JSON.stringify(trace).slice(0, 6000)`, and the command harness tail-caps its own stdout at 32_000 — so a
// preview at this size cannot change a judge's verdict, and it is the size a harness already decided was
// enough to be worth keeping.
//
// ⚠️ TWO THINGS ABOUT THAT SENTENCE WERE FALSE UNTIL arch-review 120, and both made the ceiling porous:
//
//   · IN BYTES. It was `value.length`, which counts UTF-16 code units, so a Korean tool result kept 32,000
//     characters = ~96,000 bytes inline and an emoji-heavy one ~64,000. The bound the whole design rests on
//     was 3× looser for exactly the tenants whose traces are not English.
//   · AS A WHOLE. It was applied PER STRING LEAF, so a `tool_call` bag with two hundred 31 KB leaves had no
//     leaf over the ceiling, was reported untruncated, and stayed inline at 6 MB. One event then defeats
//     every page bound downstream — which is the failure this store exists to prevent, arriving through the
//     shape it did not measure.
export const EVENT_INLINE_MAX = 32_000;

// ── AND THE BYTES THAT ARE NOT IN ANY STRING (arch-review 121) ──────────────────────────────────────
//
// The budget above measures string LEAVES and shares them fairly, which bounds a field whose size is text.
// It bounds nothing when the size is somewhere else: four hundred thousand numbers, or twenty thousand long
// KEYS with one-character values, contain no leaf over any share — so the walk reported the field untruncated
// and it stayed inline whole, at megabytes. The windowed read's whole premise is that one event is bounded,
// and for every shape that is not text it was not.
//
//     no string leaf exceeded its share   ≠   the event is within the ceiling
//
// So the preview is measured after the string pass and, if it is still over, its CONTAINERS are capped: the
// first `keep` entries of every array and object survive and the remainder becomes one `__elided__` count.
// Shape first (a reader is looking at the keys), then depth, then nothing — the cap shrinks until the whole
// preview fits, and 0 is a legal answer for a structure that cannot be described inside the budget at all.
// The ref still names the entire original, so this narrows the preview and never the evidence.
const CONTAINER_CAPS = [512, 128, 32, 8, 2, 1, 0] as const;

function capContainers(value: unknown, keep: number): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, keep).map((item) => capContainers(item, keep));
    return value.length > keep ? [...kept, { __elided__: value.length - keep }] : kept;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, keep)) out[key] = capContainers(item, keep);
    if (entries.length > keep) out.__elided__ = entries.length - keep;
    return out;
  }
  return value;
}

// The structural ceiling is the inline one with headroom, and the headroom is not a fudge: the string pass
// allocates CONTENT bytes, while this measures the SERIALIZED field — quotes, braces, commas and every key.
// A field the string pass bounded correctly is a few percent over its own budget once written out, and
// capping it here would throw away keys the first pass deliberately kept. Two ceilings, one relationship,
// stated: a preview is never larger than twice the inline ceiling, which is a hard bound where there was
// none at all.
const STRUCTURE_INLINE_MAX = EVENT_INLINE_MAX * 2;

function boundStructure(value: unknown, maxBytes: number): { preview: unknown; truncated: boolean } {
  // A scalar is whatever the string pass already made it. There is no container to cap, and replacing it
  // would discard a preview that is bounded — the first version did exactly that and emptied every plain
  // string field.
  if (value === null || typeof value !== "object") return { preview: value, truncated: false };
  if (serializedBytes(value) <= maxBytes) return { preview: value, truncated: false };
  for (const keep of CONTAINER_CAPS) {
    const capped = capContainers(value, keep);
    if (serializedBytes(capped) <= maxBytes) return { preview: capped, truncated: true };
  }
  // `keep = 0` renders any container as a single count, so this is unreachable for one — it is the total
  // answer for a shape no cap can describe, and it is still a bound.
  return { preview: { __elided__: 1 }, truncated: true };
}

// Cut a string to a byte budget WITHOUT splitting a UTF-8 sequence. `Buffer.subarray().toString()` would
// happily hand back a trailing U+FFFD, and a preview whose last character is a replacement glyph reads as
// corrupted evidence rather than as a truncation.
function truncateToBytes(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  // Continuation bytes are 10xxxxxx: walk back to the start of the sequence the cut landed inside.
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

// The keyspace. TENANT-scoped and content-addressed: a retried seal writes the same bytes to the same key
// (idempotent by construction, no orphan per attempt), and two workspaces holding identical bytes still get
// separate objects — a shared key would make one tenant's storage answer a question about another's.
function offloadKey(tenant: string, runId: string, emitter: string, field: string, value: unknown): string {
  return `trajectory-payloads/${tenant}/${runId}/${emitter}/${contentDigest(value)}.${field}`;
}

// ── WHAT "TOO LARGE" MEANS FOR A STRUCTURED FIELD ───────────────────────────────────────────────────
//
// `args` and `attributes` are bags, and what grows inside them is a STRING LEAF — a file's contents under
// `content`, a completion under `gen_ai.output.messages`. Replacing the whole bag with a marker would throw
// away the keys and the small values, which are most of what a reader is looking at.
//
// So the preview keeps the SHAPE and truncates the leaves: every key survives, every small value survives,
// and only what does not fit becomes a prefix. For a plain string field the same rule is ordinary prefix
// truncation. One traversal, one rule, and the ref always names the original whole value.
//
// ── THE BUDGET IS SHARED FAIRLY, NOT FIRST-COME (arch-review 120, design review) ────────────────────
//
// The first version of the aggregate budget spent it in `Object.entries` order, and that quietly broke the
// invariant this whole preview exists for — `docs/architecture/long-horizon-trace-reads.md` R1: "every key
// and every small value survives, and only the oversized string leaves become prefixes". Greedily, the
// first leaf takes what it wants and the rest get nothing:
//
//     { path: "out.txt", content: <100 KB> }   → path survives, content truncated       ✔
//     { content: <100 KB>, path: "out.txt" }   → content takes it all, path becomes ""  ✘
//
// Same bag, different key order, different preview. The doc's invariant was RIGHT and the implementation
// was wrong — a reader is mostly looking at the keys and the small values, and JSON key order is not
// something the design should depend on. (My own fixture used the surviving order, which is why it looked
// fine: a fixture drifted onto the weak branch, the exact vacuous shape rule `testing` names.)
//
// So the budget is allocated MAX-MIN FAIR (water-filling): every leaf is entitled to an equal share, a leaf
// smaller than its share takes only what it needs and donates the remainder, and the leaves that are still
// over the line split what is left — repeat until nothing changes. Consequences, both wanted:
//   · a leaf under the fair share ALWAYS survives whole, whatever its position;
//   · 200 leaves of 20 KB each keep a 160-byte prefix apiece rather than one keeping 32 KB and 199 keeping
//     nothing;
//   · `{path, content}` and `{content, path}` produce the same preview.
function previewOf(value: unknown, totalBudget: number): { preview: unknown; truncated: boolean } {
  const sizes: number[] = [];
  collectLeafSizes(value, sizes);
  const share = fairShare(sizes, totalBudget);
  const cursor = { index: 0 };
  return applyPreview(value, share, cursor);
}

// Every string leaf's byte size, in traversal order — the same order `applyPreview` walks, so the two agree
// leaf for leaf without threading a key path through either.
function collectLeafSizes(value: unknown, out: number[]): void {
  if (typeof value === "string") {
    out.push(Buffer.byteLength(value, "utf8"));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeafSizes(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) for (const item of Object.values(value)) collectLeafSizes(item, out);
}

// Max-min fair share: the largest per-leaf allowance under which the total fits. Leaves under the allowance
// keep everything and donate the rest, which raises the allowance for those still over it — so the answer is
// found by repeating until the set of over-the-line leaves stops shrinking.
function fairShare(sizes: readonly number[], totalBudget: number): number {
  let pool = [...sizes];
  let remaining = totalBudget;
  let contenders = pool.length;
  if (contenders === 0) return 0;
  for (;;) {
    const share = Math.floor(remaining / contenders);
    const settled = pool.filter((size) => size <= share && size > 0);
    // Nobody new fits entirely inside the share — everyone still over the line splits what is left.
    if (settled.length === 0 || settled.length === contenders) return share;
    const donated = settled.reduce((sum, size) => sum + size, 0);
    remaining -= donated;
    contenders -= settled.length;
    if (contenders === 0) return share;
    pool = pool.filter((size) => size > share || size === 0);
  }
}

// The second pass. `cursor` walks the leaves in the SAME order `collectLeafSizes` did, so each leaf is
// measured against its own entitlement rather than against whatever the previous leaves left behind.
function applyPreview(
  value: unknown,
  share: number,
  cursor: { index: number },
): { preview: unknown; truncated: boolean } {
  if (typeof value === "string") {
    cursor.index += 1;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes <= share) return { preview: value, truncated: false };
    return { preview: truncateToBytes(value, share), truncated: true };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const preview = value.map((item) => {
      const inner = applyPreview(item, share, cursor);
      truncated ||= inner.truncated;
      return inner.preview;
    });
    return { preview, truncated };
  }
  if (typeof value === "object" && value !== null) {
    let truncated = false;
    const preview: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const inner = applyPreview(item, share, cursor);
      truncated ||= inner.truncated;
      preview[key] = inner.preview;
    }
    return { preview, truncated };
  }
  return { preview: value, truncated: false };
}

// Which field of which event kind can be offloaded, and how it is read and written. Declared as data so the
// seal path and the resolve path cannot disagree about the pairing — a `<x>`/`<x>Ref` mismatch would leave a
// ref nobody resolves or a preview nobody notices is one.
interface OffloadField {
  kind: TraceEvent["kind"] | "span-record";
  field: string;
  ref: string;
}
const OFFLOADABLE: readonly OffloadField[] = [
  { kind: "message", field: "text", ref: "textRef" },
  { kind: "tool_call", field: "args", ref: "argsRef" },
  { kind: "tool_result", field: "output", ref: "outputRef" },
  { kind: "log", field: "text", ref: "textRef" },
  { kind: "span", field: "attributes", ref: "attributesRef" },
];

function fieldsFor(kind: string): OffloadField[] {
  return OFFLOADABLE.filter((f) => f.kind === kind);
}

// ── THE ONE OWNER THAT ENDS THESE BYTES (arch-review 120) ──────────────────────────────────────────
//
// `ArtifactStore` deliberately has no `remove`: almost everything it holds is EVIDENCE, and a delete on the
// shared port would be a capability forty callers have and nobody should use. Both concrete stores implement
// one anyway, and `AgentHalfStore` is the precedent for asking narrowly.
//
// Retention is the second owner. A trajectory past its retention window is deleted from the database, and
// until now its offloaded payloads were not deleted from anywhere — the rows that named the keys went away
// and the bytes stayed, with nothing left to enumerate them.
//
//     trajectory retention applied   ≠   tenant payload erased
//
// That is a privacy question rather than a storage-cost one, which is why this port exists at all.
// How many payload objects one retention sweep accounts for. The sweep is periodic, so a bound here is a
// pace rather than a cap — the rows it could not account for are simply deleted by a later pass.
export const PAYLOAD_SWEEP_LIMIT = 5_000;

export interface TrajectoryPayloadArtifacts extends ArtifactStore {
  // Retention needs an artifact store that can DELETE, which the shared `ArtifactStore` port deliberately
  // does not declare (only two owners want it, and both hold a concrete store). An outage THROWS — an
  // outage is not an absence, and swallowing it here is how the bytes became unfindable in the first place.
  remove(key: string): Promise<void>;
}

export class OffloadingTrajectoryStore implements TrajectoryStore {
  constructor(
    private readonly inner: TrajectoryStore,
    // The NARROW port, not the shared one: this decorator is the owner that ends these bytes, so it is the
    // one place that asks for a delete (arch-review 120).
    private readonly artifacts: TrajectoryPayloadArtifacts,
    // How many refs one enumeration returns. Production takes the default; a counterexample lowers it so the
    // `limit + 1` case is three payloads rather than five thousand — the property is the composition, not
    // the size, and a test that needs 160 MB of fixture is a test nobody runs.
    private readonly sweepLimit: number = PAYLOAD_SWEEP_LIMIT,
  ) {}

  async seal(input: SealInput): Promise<TrajectoryMeta & { created: boolean }> {
    const emitter = input.emitter ?? input.source;
    const events = input.events !== undefined ? await this.offloadEvents(input, emitter, input.events) : undefined;
    const spans = input.spans !== undefined ? await this.offloadSpans(input, emitter, input.spans) : undefined;
    return this.inner.seal({
      ...input,
      ...(events !== undefined ? { events } : {}),
      ...(spans !== undefined ? { spans } : {}),
    });
  }

  private async offloadEvents(input: SealInput, emitter: string, events: TraceEvent[]): Promise<TraceEvent[]> {
    const out: TraceEvent[] = [];
    for (const event of events) {
      let next: Record<string, unknown> = { ...event };
      for (const spec of fieldsFor(event.kind)) {
        const moved = await this.move(input, emitter, spec.field, next[spec.field]);
        if (moved !== undefined) next = { ...next, [spec.field]: moved.preview, [spec.ref]: moved.ref };
      }
      out.push(next as TraceEvent);
    }
    return out;
  }

  // A span's attribute bag is the same question one layer in. `resource` is deliberately left alone: it
  // describes the emitting PROCESS (service name, pod, node) and is small by construction.
  private async offloadSpans(input: SealInput, emitter: string, spans: TraceSpan[]): Promise<TraceSpan[]> {
    const out: TraceSpan[] = [];
    for (const span of spans) {
      const moved = await this.move(input, emitter, "attributes", span.attributes);
      out.push(
        moved === undefined
          ? span
          : ({
              ...span,
              attributes: moved.preview as Record<string, unknown>,
              attributesRef: moved.ref,
            } as TraceSpan),
      );
    }
    return out;
  }

  // Undefined = this value stays where it is. A PUT FAILURE also answers undefined, deliberately: the
  // alternative is sealing a ref that names bytes which do not exist — a pointer into nothing, which every
  // later resolve would refuse and no reader could repair. Keeping the payload inline is the same trajectory
  // this store would have written yesterday, so the failure costs size and never evidence.
  private async move(
    input: SealInput,
    emitter: string,
    field: string,
    value: unknown,
  ): Promise<{ preview: unknown; ref: string } | undefined> {
    if (value === undefined || value === null) return undefined;
    const strings = previewOf(value, EVENT_INLINE_MAX);
    // Two passes, because they bound different things: the first shares the budget between string leaves,
    // the second caps the containers when the bytes were never in the strings at all.
    const structure = boundStructure(strings.preview, STRUCTURE_INLINE_MAX);
    const preview = structure.preview;
    if (!strings.truncated && !structure.truncated) return undefined;
    const key = offloadKey(input.tenant, input.runId, emitter, field, value);
    try {
      await this.artifacts.put(key, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
    } catch {
      return undefined;
    }
    return { preview, ref: artifactRefOf(key) };
  }

  async events(tenant: string, runId: string, window: TrajectoryWindow): Promise<TrajectoryEventsResult> {
    const result = await this.inner.events(tenant, runId, window);
    if (result.kind !== "page" || window.resolve !== true) return result;

    // ── A SPANS PLANE IS RE-PROJECTED, NOT PATCHED ────────────────────────────────────────────────
    //
    // For a spans plane the store PROJECTS the events out of the attributes before this decorator ever sees
    // them. If an attribute bag was offloaded, that projection ran over the PREVIEW — so a `tool_result`
    // derived from `gen_ai.output.messages` carries the excerpt and no ref of its own, and resolving the
    // spans afterwards would fix the record while leaving the stream every judge reads truncated. Silently.
    //
    // So the record is resolved first and the projection is redone from it, with the plane's own batch facts
    // (carried on the page for exactly this) so the re-projection is the whole-plane one and not the page's.
    if (result.page.spans !== undefined) {
      const spans = await Promise.all(result.page.spans.map((span) => this.resolveSpan(span, tenant, runId)));
      return {
        kind: "page",
        page: {
          ...result.page,
          spans,
          events: spansToEvents(spans, result.page.batch !== undefined ? { batch: result.page.batch } : {}),
        },
      };
    }
    // ── A RESOLVED PAGE IS BOUNDED IN BYTES, NOT ONLY IN EVENTS (arch-review 121) ──────────────────
    //
    // `MAX_RESOLVED_EVENT_PAGE` clamps the COUNT, and an offloaded event's stored size is its preview —
    // which predicts nothing about what resolving it materializes. Fifty events whose payloads are 10 MB
    // each is 500 MB in one shared process, through a read any member with `runs:read` can ask for. So the
    // budget is spent as the page is built and the page stops before the event that would exceed it.
    //
    // Resolved SEQUENTIALLY rather than with `Promise.all`, deliberately: the point is to stop before
    // materializing the rest, and a parallel map has already fetched everything by the time anyone counts.
    //
    // At least one event always comes back. A payload larger than the whole budget is served alone — a page
    // that can come back empty is a stream that never advances, which is the pager's own law one layer up.
    const start = clampWindow(window).after;
    const resolved: TraceEvent[] = [];
    let spent = 0;
    for (const event of result.page.events) {
      const one = await this.resolveEvent(event, tenant, runId);
      const size = serializedBytes(one);
      if (resolved.length > 0 && spent + size > MAX_RESOLVED_PAGE_BYTES)
        // The cursor is the ABSOLUTE index of the first event we did not include, which is where the inner
        // page began plus what we kept — the same coordinate `pageOf` hands back, so a caller pages on
        // without knowing a budget stopped it.
        return { kind: "page", page: { ...result.page, events: resolved, nextAfter: start + resolved.length } };
      resolved.push(one);
      spent += size;
    }
    return { kind: "page", page: { ...result.page, events: resolved } };
  }

  private async resolveEvent(event: TraceEvent, tenant: string, runId: string): Promise<TraceEvent> {
    let next: Record<string, unknown> = { ...event };
    for (const spec of fieldsFor(event.kind)) {
      const ref = next[spec.ref];
      if (typeof ref !== "string") continue;
      next = { ...next, [spec.field]: await this.fetch(ref, tenant, runId), [spec.ref]: undefined };
    }
    return next as TraceEvent;
  }

  private async resolveSpan(span: TraceSpan, tenant: string, runId: string): Promise<TraceSpan> {
    const ref = (span as { attributesRef?: unknown }).attributesRef;
    if (typeof ref !== "string") return span;
    const attributes = (await this.fetch(ref, tenant, runId)) as Record<string, unknown>;
    return { ...span, attributes, attributesRef: undefined } as TraceSpan;
  }

  // A resolve was ASKED for, so a preview is not an acceptable answer to it: a judge handed an excerpt under
  // the name of the whole scores different evidence and nothing downstream can tell. Both failures throw —
  // an unreadable store is an outage, and a MISSING object is worse than an outage (the record points at
  // bytes that are gone), so neither may degrade quietly into "here is what we still had".
  private async fetch(ref: string, tenant: string, runId: string): Promise<unknown> {
    const key = artifactKeyOf(ref);
    if (key === undefined)
      throw new UpstreamError("UPSTREAM_ERROR", { ref }, `Trace payload ref '${ref}' is not an artifact handle.`);
    // ⚠️ AND IT MUST BE THIS TRAJECTORY'S OBJECT (arch-review 121). `TraceEvent` is the schema a producer's
    // submission is validated by, so a caller can author `outputRef` itself — and this read used to hand
    // back whatever key it was given, which is evidence substitution when the bytes are somebody else's and
    // disclosure when the caller only wanted to see them. The key carries its owner; they must agree.
    if (!ownsPayloadKey(key, tenant, runId))
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { ref, runId },
        `Trace payload ref '${ref}' names an object this trajectory does not own — a ref is not authority over what it points at.`,
      );
    const bytes = await this.artifacts.get(key);
    if (bytes === undefined)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { ref },
        `Trace payload '${key}' is gone from object storage — the trajectory references bytes the artifact store no longer holds.`,
      );
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  }

  planes(tenant: string, runId: string, opts?: { attemptId: string }): Promise<SealedTrajectory | undefined> {
    return this.inner.planes(tenant, runId, opts);
  }

  usage(tenant: string, runId: string): Promise<TrajectoryUsage> {
    return this.inner.usage(tenant, runId);
  }

  list(
    tenant: string,
    opts?: { limit?: number; cursor?: string; viewer?: string; kind?: string },
  ): Promise<TrajectoryListResult> {
    return this.inner.list(tenant, opts);
  }

  ingestedSince(tenant: string, sinceIso: string): Promise<{ trajectories: number; events: number }> {
    return this.inner.ingestedSince(tenant, sinceIso);
  }

  // ── RETENTION DELETES THE BYTES, NOT ONLY THE ROWS (arch-review 120) ────────────────────────────
  //
  // This forwarded straight through, so a retention sweep removed the DATABASE rows and left every offloaded
  // payload in object storage — permanently, and undiscoverably, because the rows were the only thing that
  // named the keys. A tenant asking for their evidence to be deleted got a successful answer and kept bytes.
  //
  // ⚠️ OBJECTS FIRST, THEN ROWS, and the order is the whole design. Deleting rows first is what produced an
  // INVISIBLE orphan: an object nothing points at cannot be found by any later sweep. Deleting objects first
  // leaves the mirror image for one sweep — a row whose payload is gone — and that one is VISIBLE and
  // self-healing: a resolve fails closed (loud, and correct: retention removed the evidence), and the next
  // sweep deletes the row. A window in which expired evidence reads as unresolvable is the honest cost.
  //
  // The enumeration is REQUIRED on the port, not optional, and that is this change's other half: the first
  // draft asked `this.inner.payloadRefsOlderThan === undefined` and fell back to the plain delete — and
  // `NamingTrajectoryStore` sits between this decorator and the concrete store, so the fallback is the arm
  // every production deployment would have taken (L2 — a read that did not happen is not an empty answer).
  async deleteOlderThan(cutoffIso: string): Promise<number> {
    // Bounded per sweep for the same reason every other worklist here is: a retention pass that tries to hold
    // every ref in a decade of trajectories is a pass that never finishes.
    // ⚠️ DRAINED, NOT SAMPLED (arch-review 121). This read used to be a single bounded call followed by
    // `deleteOlderThan(cutoff)`, which deletes EVERY expired row — so at `limit + 1` distinct refs the last
    // object was orphaned permanently, named by nothing any later pass could find. Both lines were right
    // alone. The cursor pages until the enumeration is exhausted, so no row is deleted until every ref it
    // carries has been accounted for.
    const page = this.sweepLimit;
    let after: string | undefined;
    for (;;) {
      const refs: TrajectoryPayloadRef[] = await this.inner.payloadRefsOlderThan(cutoffIso, page, after);
      if (refs.length === 0) break;
      for (const owned of refs) {
        const key = artifactKeyOf(owned.ref);
        // A ref this store did not mint is not ours to delete — and it is not an error either: an event may
        // carry a handle to somebody else's object store entirely.
        if (key === undefined) continue;
        // …and neither is a ref that names ANOTHER trajectory's object. `TraceEvent` is the schema a
        // producer's submission is validated by, so a caller can write `outputRef` into its own trace; the
        // row says which trajectory holds this ref, and the key says which one owns the bytes. They must
        // agree or the delete is somebody else's evidence (arch-review 121).
        if (!ownsPayloadKey(key, owned.tenant, owned.runId)) continue;
        // Not swallowed. An outage here must stop the sweep before it deletes the rows that name these keys,
        // because a swallowed failure is precisely how the bytes became unfindable in the first place.
        await this.artifacts.remove(key);
      }
      if (refs.length < page) break;
      after = refs[refs.length - 1]?.ref;
      if (after === undefined) break;
    }
    return this.inner.deleteOlderThan(cutoffIso);
  }

  // Forwarded verbatim: the refs are the INNER store's rows to enumerate, and this decorator's only business
  // with them is deleting what they name.
  payloadRefsOlderThan(cutoffIso: string, limit: number, after?: string): Promise<TrajectoryPayloadRef[]> {
    return this.inner.payloadRefsOlderThan(cutoffIso, limit, after);
  }
}
