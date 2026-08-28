import { type TraceEvent, type TraceSpan, UpstreamError } from "@everdict/contracts";
import { contentDigest, spansToEvents } from "@everdict/domain";
import { type ArtifactStore, artifactKeyOf, artifactRefOf } from "./artifact-store.js";
import type {
  SealInput,
  SealedTrajectory,
  TrajectoryEventsResult,
  TrajectoryListResult,
  TrajectoryMeta,
  TrajectoryStore,
  TrajectoryUsage,
  TrajectoryWindow,
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

// How much of one field stays inline. Chosen against the two truncations that already exist downstream: the
// model judge renders the whole trace as `JSON.stringify(trace).slice(0, 6000)`, and the command harness
// tail-caps its own stdout at 32_000 — so a preview at this size cannot change a judge's verdict, and it is
// the size a harness already decided was enough to be worth keeping.
export const EVENT_INLINE_MAX = 32_000;

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
// and only the oversized strings become prefixes. For a plain string field the same rule is ordinary
// prefix truncation. One traversal, one rule, and the ref always names the original whole value.
function previewOf(value: unknown): { preview: unknown; truncated: boolean } {
  if (typeof value === "string")
    return value.length > EVENT_INLINE_MAX
      ? { preview: value.slice(0, EVENT_INLINE_MAX), truncated: true }
      : { preview: value, truncated: false };
  if (Array.isArray(value)) {
    let truncated = false;
    const preview = value.map((item) => {
      const inner = previewOf(item);
      truncated ||= inner.truncated;
      return inner.preview;
    });
    return { preview, truncated };
  }
  if (typeof value === "object" && value !== null) {
    let truncated = false;
    const preview: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const inner = previewOf(item);
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

export class OffloadingTrajectoryStore implements TrajectoryStore {
  constructor(
    private readonly inner: TrajectoryStore,
    private readonly artifacts: ArtifactStore,
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
    const { preview, truncated } = previewOf(value);
    if (!truncated) return undefined;
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
      const spans = await Promise.all(result.page.spans.map((span) => this.resolveSpan(span)));
      return {
        kind: "page",
        page: {
          ...result.page,
          spans,
          events: spansToEvents(spans, result.page.batch !== undefined ? { batch: result.page.batch } : {}),
        },
      };
    }
    return {
      kind: "page",
      page: {
        ...result.page,
        events: await Promise.all(result.page.events.map((event) => this.resolveEvent(event))),
      },
    };
  }

  private async resolveEvent(event: TraceEvent): Promise<TraceEvent> {
    let next: Record<string, unknown> = { ...event };
    for (const spec of fieldsFor(event.kind)) {
      const ref = next[spec.ref];
      if (typeof ref !== "string") continue;
      next = { ...next, [spec.field]: await this.fetch(ref), [spec.ref]: undefined };
    }
    return next as TraceEvent;
  }

  private async resolveSpan(span: TraceSpan): Promise<TraceSpan> {
    const ref = (span as { attributesRef?: unknown }).attributesRef;
    if (typeof ref !== "string") return span;
    const attributes = (await this.fetch(ref)) as Record<string, unknown>;
    return { ...span, attributes, attributesRef: undefined } as TraceSpan;
  }

  // A resolve was ASKED for, so a preview is not an acceptable answer to it: a judge handed an excerpt under
  // the name of the whole scores different evidence and nothing downstream can tell. Both failures throw —
  // an unreadable store is an outage, and a MISSING object is worse than an outage (the record points at
  // bytes that are gone), so neither may degrade quietly into "here is what we still had".
  private async fetch(ref: string): Promise<unknown> {
    const key = artifactKeyOf(ref);
    if (key === undefined)
      throw new UpstreamError("UPSTREAM_ERROR", { ref }, `Trace payload ref '${ref}' is not an artifact handle.`);
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

  deleteOlderThan(cutoffIso: string): Promise<number> {
    return this.inner.deleteOlderThan(cutoffIso);
  }
}
