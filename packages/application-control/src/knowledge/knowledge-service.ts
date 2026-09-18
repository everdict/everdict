import {
  BadRequestError,
  type KnowledgeEntryRecord,
  type KnowledgePin,
  type NodeRef,
  type RetrievalReceiptOutcome,
} from "@everdict/contracts";
import { type AnchorRelation, type Coverage, anchorRelation } from "@everdict/domain";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";
import type { SkillStore } from "../ports/skill-store.js";
import { type LatestVersionResolver, resolveCoverage } from "./freshness-resolver.js";
import type { RetrievalReceiptWriter } from "./retrieval-receipt-writer.js";

// What task-time context assembly reads: the knowledge-entry and skill RECORDS themselves (always current — there is
// no projection to wait for), plus the latest-version resolver that places each anchor on its family's timeline and
// decorates every matched item with its coverage against the present. Without a resolver an unversioned anchor has no
// coordinate (its matches carry no relation) and no item is coverage-decorated.
export interface KnowledgeServiceDeps {
  skills: Pick<SkillStore, "list">;
  knowledgeEntries: Pick<KnowledgeEntryStore, "list">;
  latestVersionOf?: LatestVersionResolver;
  // Absent = this deployment files no retrieval receipts, and every assembly SAYS so in its result rather
  // than answering as though it had. See `RetrievalReceiptOutcome`.
  receipts?: RetrievalReceiptWriter;
}

// A skill candidate in the assembled context — listing-level only (name/description/refs/coverage/relation), never
// the instructions body: selection stays cheap, the agent loads the body via use_skill when it picks one.
export interface TaskContextSkill {
  id: string;
  name: string;
  description: string;
  refs: KnowledgePin[];
  coverage?: Coverage;
  relation?: AnchorRelation;
}

// assembleContext's result — the one payload that feeds the in-product agent, spawned subagents, and Claude Code via
// the plugin (MCP get_task_context): the workspace's knowledge entries and skill candidates ABOUT the anchors. Each item
// carries its ANCHOR RELATION — where its known-valid interval sits relative to the anchor coordinate
// (`covers | earlier | later | general`): the anchor's own version IS the as-of coordinate (pass an old scorecard's
// harness@2.1.0 and the knowledge base is projected onto that point; an unversioned anchor projects onto the present).
// See docs/architecture/workspace-knowledge.md §Task-context assembly.
// ── WHAT AN ASSEMBLED ENTRY CARRIES ──────────────────────────────────────────────────────────────────
//
// One shape for both readings, because two types would let a caller hold a "full" entry whose body is absent.
// `body` is present only when the caller asked for it; `bodyChars` is ALWAYS present, so a projection says how
// much it withheld rather than looking like an entry that had nothing to say. The measurement that forced
// this: one anchor over 20 entries returned 76,617 characters and exceeded the caller's output limit, and one
// entry in that set is 8,238 characters on its own.
export type TaskContextEntry = Omit<KnowledgeEntryRecord, "body"> & {
  body?: string;
  bodyChars: number;
  coverage?: Coverage;
  relation?: AnchorRelation;
};

export interface TaskContext {
  knowledge: TaskContextEntry[];
  skills: TaskContextSkill[];
  // HOW MANY THERE WERE, against how many came back. The service already computed these and passed them only
  // to the receipt writer, so a caller served 20 of 200 could not tell that from being served everything —
  // which is a bounded read reporting "there is no more" when it means "I stopped" (rule `protocol` L2).
  // It matters most HERE, because `recordUse` measures the citation rate and a rate over a silently truncated
  // page is computed on the wrong denominator.
  available: { knowledge: number; skills: number };
  // WHETHER WHAT WAS RETURNED WAS RECORDED. Not optional: a caller that never sees the outcome cannot tell a
  // deployment that files receipts from one that silently does not, and every measurement over the receipt
  // series would then be computed on a corpus with invisible holes (rule `protocol` L2).
  receipt: RetrievalReceiptOutcome;
}

// The most entries and the most skill candidates one context carries, when the caller states no limit.
const CONTEXT_PAGE = 20;
// The ceiling a caller may raise it to. A request above this is REFUSED rather than clamped: silently serving
// 100 to someone who asked for 1000 answers a question they did not ask.
const CONTEXT_MAX_PAGE = 100;

export interface AssembleContextOptions {
  // `include` (the DEFAULT) keeps every entry's body. The default is deliberate and not the cheaper one: the
  // delegation brief assembles a delegate's inherited knowledge through this service, and its body travels on
  // purpose — "a delegate has no channel here, so a title it cannot open is a rumour rather than a pointer".
  // A caller that is not updated therefore keeps today's behaviour, which is loud (an oversized response)
  // rather than silent (a delegate briefed with titles it cannot open). Between two ways to be wrong, default
  // to the one that announces itself.
  body?: "include" | "omit";
  limit?: number;
}

// The control-plane service behind task-time context assembly — the consumption surface of the workspace's knowledge.
// Both transports (POST /knowledge/context + MCP get_task_context) call this one service.
export class KnowledgeService {
  // Injected for the same reason every other service injects it: a test that cannot pin the clock cannot pin
  // the record it produces.
  private readonly now: () => string = () => new Date().toISOString();

  constructor(private readonly deps: KnowledgeServiceDeps) {}

  // For a set of anchors (the entities a task concerns: @-references, the scorecard under discussion, a harness being
  // edited), returns the knowledge entries and skill candidates ABOUT those anchors — family-matched on (type, key), so
  // a claim pinned at web-agent@2.1.0 still surfaces when the task anchors web-agent@2.3.0.
  //
  // AS-OF PROJECTION: the anchor's own version is the coordinate the knowledge base is projected onto — an
  // unversioned anchor resolves to the family's current latest (present-projection); an old scorecard's
  // harness@2.1.0 anchor projects onto that point. Each matched item carries its ANCHOR RELATION
  // (`covers | earlier | later | general`), and the ranking is relation > status > recency — at a past coordinate a
  // SUPERSEDED claim that covers it outranks an active claim pinned later (time is a coordinate, not decay).
  // `observer.sessionId` is the SERVER'S correlator (the MCP transport's generated id), never a client label:
  // a receipt keyed by something the caller chooses could be filed into another session's directory. Absent
  // is legal and answered honestly — an HTTP caller or a background job has no session, and the assembly
  // says `unattributed` instead of inventing one.
  async assembleContext(
    tenant: string,
    subject: string,
    anchors: NodeRef[],
    observer?: { sessionId?: string },
    options?: AssembleContextOptions,
  ): Promise<TaskContext> {
    const page = resolveContextLimit(options?.limit);
    const withBody = (options?.body ?? "include") === "include";
    const { skills: skillStore, knowledgeEntries, latestVersionOf } = this.deps;
    const now = new Date().toISOString();

    // The projection coordinate per anchor family: the anchor's own version, else the family's current latest.
    const famKey = (r: NodeRef): string => `${r.type}:${r.key}`;
    const coordinates = new Map<string, string | undefined>();
    for (const a of anchors) {
      const coordinate = a.version ?? (await latestVersionOf?.(tenant, a));
      coordinates.set(famKey(a), coordinate);
    }
    const matches = (refs: NodeRef[]): boolean => refs.some((r) => coordinates.has(famKey(r)));

    // The strongest relation of a record's pins to the anchor coordinates. Priority mirrors the ranking: confirmed-
    // at-this-coordinate and timeless claims lead; earlier (validity here unknown) next; later (from this
    // coordinate's future — the "what happened next" trail) last.
    const RELATION_TIER: Record<AnchorRelation, number> = { covers: 0, general: 0, earlier: 1, later: 2 };
    const relationFor = (refs: KnowledgePin[]): AnchorRelation | undefined => {
      let best: AnchorRelation | undefined;
      for (const pin of refs) {
        if (!coordinates.has(famKey(pin))) continue; // not an anchor family
        const rel = anchorRelation(pin, coordinates.get(famKey(pin)));
        if (rel === undefined) continue; // unresolved coordinate — indeterminate, never penalized
        if (best === undefined || RELATION_TIER[rel] < RELATION_TIER[best]) best = rel;
      }
      return best;
    };
    const tier = (rel: AnchorRelation | undefined): number => (rel === undefined ? 0 : RELATION_TIER[rel]);
    const baseline = (r: { verifiedAt?: string; updatedAt: string }): string =>
      r.verifiedAt !== undefined && r.verifiedAt > r.updatedAt ? r.verifiedAt : r.updatedAt;

    // Proposed (unreviewed) candidates never feed agent context — review first, then they count as knowledge.
    const matchedEntries = (await knowledgeEntries.list(tenant, subject)).filter(
      (e) => e.status !== "proposed" && matches(e.refs),
    );
    const entriesWithRelation = matchedEntries.map((e) => ({ entry: e, relation: relationFor(e.refs) }));
    // relation > status > recency: a superseded claim that COVERS the anchor coordinate is that coordinate's
    // truth — it outranks an active claim from the coordinate's future. Status only breaks ties within a tier.
    entriesWithRelation.sort((a, b) => {
      const t = tier(a.relation) - tier(b.relation);
      if (t !== 0) return t;
      if (a.entry.status !== b.entry.status) return a.entry.status === "active" ? -1 : 1;
      return baseline(b.entry).localeCompare(baseline(a.entry));
    });
    const entryPage = entriesWithRelation.slice(0, page);
    const entryCoverage = latestVersionOf
      ? await resolveCoverage(
          tenant,
          entryPage.map((p) => p.entry),
          latestVersionOf,
          now,
        )
      : undefined;
    const knowledge: TaskContext["knowledge"] = entryPage.map(({ entry, relation }, i) => {
      const c = entryCoverage?.[i];
      const { body, ...rest } = entry;
      return {
        ...rest,
        // The size travels even when the text does not: "this claim is 8k of detail you have not read" and
        // "this claim is a sentence" are different things to do next, and an absent body says neither.
        bodyChars: body.length,
        ...(withBody ? { body } : {}),
        ...(relation !== undefined ? { relation } : {}),
        ...(c !== undefined ? { coverage: c } : {}),
      };
    });

    const matchedSkills = (await skillStore.list(tenant, subject)).filter((s) => matches(s.refs));
    const skillsWithRelation = matchedSkills.map((s) => ({ record: s, relation: relationFor(s.refs) }));
    skillsWithRelation.sort((a, b) => tier(a.relation) - tier(b.relation));
    const skillPage = skillsWithRelation.slice(0, page);
    const skillCoverage = latestVersionOf
      ? await resolveCoverage(
          tenant,
          skillPage.map((p) => p.record),
          latestVersionOf,
          now,
        )
      : undefined;
    const skills: TaskContextSkill[] = skillPage.map(({ record, relation }, i) => {
      const c = skillCoverage?.[i];
      return {
        id: record.id,
        name: record.name,
        description: record.description,
        refs: record.refs,
        ...(c !== undefined ? { coverage: c } : {}),
        ...(relation !== undefined ? { relation } : {}),
      };
    });

    const receipt = await this.fileReceipt(tenant, subject, anchors, observer?.sessionId, {
      knowledge,
      skills,
      knowledgeAvailable: entriesWithRelation.length,
      skillsAvailable: skillsWithRelation.length,
      at: now,
    });
    return {
      knowledge,
      skills,
      available: { knowledge: entriesWithRelation.length, skills: skillsWithRelation.length },
      receipt,
    };
  }

  // ── THE SESSION'S ACCOUNT ──────────────────────────────────────────────────────────────────────────
  //
  // What the session USED is knowable nowhere else, so the platform cannot produce it — but it CAN check the
  // citations, and that is the difference between a measurement and a note. Every cited entry is resolved
  // against this workspace's own records and a citation that does not resolve is REFUSED, the way
  // `publish_checkpoint` refuses a fact whose evidence is not there: a series built on unresolvable ids is
  // wrong in a way nobody can see later.
  //
  // An EMPTY `used` is accepted and is a real answer — "the workspace had nothing for this work" is the
  // measurement that decides whether this layer earns its keep.
  async recordUse(
    tenant: string,
    subject: string,
    input: { sessionId: string; assemblyPath: string; used: string[]; outcome: string },
  ): Promise<RetrievalReceiptOutcome> {
    const writer = this.deps.receipts;
    if (!writer) return { recorded: false, reason: "unconfigured" };
    const entries = await this.deps.knowledgeEntries.list(tenant, subject);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const cited: { id: string; title: string }[] = [];
    for (const id of input.used) {
      const entry = byId.get(id);
      if (entry === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { id },
          `knowledge entry '${id}' is not one this workspace can show you — a citation nobody can resolve makes the measurement wrong in a way no later reader can see.`,
        );
      cited.push({ id: entry.id, title: entry.title });
    }
    return writer.writeUse({
      at: this.now(),
      tenant,
      subject,
      sessionId: input.sessionId,
      assemblyPath: input.assemblyPath,
      used: cited,
      outcome: input.outcome,
    });
  }

  // The receipt is written by the assembly because only the assembly knows what it answered — including what
  // the page CUT, which the returned list cannot show. Failure is reported, never thrown and never swallowed.
  private async fileReceipt(
    tenant: string,
    subject: string,
    anchors: NodeRef[],
    sessionId: string | undefined,
    answered: {
      knowledge: TaskContext["knowledge"];
      skills: TaskContextSkill[];
      knowledgeAvailable: number;
      skillsAvailable: number;
      at: string;
    },
  ): Promise<RetrievalReceiptOutcome> {
    const writer = this.deps.receipts;
    if (!writer) return { recorded: false, reason: "unconfigured" };
    if (sessionId === undefined || sessionId === "") return { recorded: false, reason: "unattributed" };
    return writer.write({
      at: answered.at,
      tenant,
      subject,
      sessionId,
      anchors,
      knowledge: answered.knowledge.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        status: e.status,
        ...(e.relation !== undefined ? { relation: e.relation } : {}),
        ...(e.coverage !== undefined ? { coverage: e.coverage.state } : {}),
      })),
      skills: answered.skills.map((sk) => ({
        id: sk.id,
        name: sk.name,
        ...(sk.relation !== undefined ? { relation: sk.relation } : {}),
      })),
      counts: {
        knowledgeAvailable: answered.knowledgeAvailable,
        knowledgeReturned: answered.knowledge.length,
        skillsAvailable: answered.skillsAvailable,
        skillsReturned: answered.skills.length,
      },
    });
  }
}

// A limit the caller did not state is the page this service has always served. One outside the range is
// REFUSED rather than clamped, for the same reason the lineage walk refuses an out-of-range depth: a silently
// adjusted answer is an answer to a question nobody asked.
function resolveContextLimit(requested: number | undefined): number {
  if (requested === undefined) return CONTEXT_PAGE;
  if (!Number.isInteger(requested) || requested < 1 || requested > CONTEXT_MAX_PAGE)
    throw new BadRequestError(
      "BAD_REQUEST",
      { limit: requested, max: CONTEXT_MAX_PAGE },
      `limit must be an integer between 1 and ${CONTEXT_MAX_PAGE} — the default is ${CONTEXT_PAGE}, and \`available\` tells you how many there were`,
    );
  return requested;
}
