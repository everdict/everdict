import type { CommentStore, KnowledgeEntryService } from "@everdict/application-control";
import {
  BadRequestError,
  type CommentRecord,
  type KnowledgeEntryKind,
  KnowledgeEntryKindSchema,
  type KnowledgeEntryRecord,
  type NodeRef,
  NodeRefSchema,
  NodeTypeSchema,
  NotFoundError,
} from "@everdict/contracts";
import { modelApiKeySecretName } from "@everdict/domain";
import { type JudgeCompletion, transportComplete } from "@everdict/graders";
import { transportFor } from "@everdict/llm";
import type { ModelRegistry } from "@everdict/registry";
import type { ScopedSecretTiers } from "../execution/judge-auth-dispatcher.js";

// knowledge-extract — the accumulation loop's EXTRACTION leg (docs/architecture/knowledge-graph.md): mine a closed
// discussion (a comment thread) for durable, evidence-backed conclusions and store them as `proposed` knowledge
// entries (confidence < 1, authored by the extractor sentinel) awaiting HITL review — approval promotes a proposal to
// an authored claim. On-demand today (HTTP/MCP; a platform-event trigger can drive it later). Reuses the
// skill-generate model plumbing: the workspace's registered model + key, provider-native completion.

export const KNOWLEDGE_EXTRACTOR = "knowledge_extractor_v1";
const MAX_PROPOSALS_PER_RUN = 5;
const EXTRACT_MAX_TOKENS = 4096;

const SYSTEM_PROMPT = [
  "You are a knowledge extractor for Everdict — a runtime that runs and evaluates agent harnesses and produces",
  "scorecards, judge verdicts, and traces. You read a WORKSPACE DISCUSSION THREAD and mine it for DURABLE,",
  "evidence-backed conclusions worth keeping as workspace knowledge: an observed fact the participants established",
  "(finding), a choice they settled with its rationale (decision), a working agreement (convention), or background a",
  "newcomer would need (context).",
  "",
  "Output ONLY a JSON array (possibly empty) of candidate entries, each with exactly these keys:",
  '  "kind": one of "finding" | "decision" | "convention" | "context",',
  '  "title": the one-line claim itself (≤ 200 chars, standalone — readable without the thread),',
  '  "body": markdown with the specifics: what was established, caveats, who/what it applies to,',
  '  "refs": entities the claim concerns, as {"type", "key", "version"?} — type is one of harness | dataset | judge |',
  "     model | runtime | rubric | agent | scorecard | run | case | capability | skill; use EXACT ids that appear in",
  "     the thread, pin the version only when the thread names one, and use [] when no concrete entity is named,",
  '  "confidence": 0..1 — how clearly the thread supports the claim.',
  "",
  "Rules: extract only conclusions the participants actually reached — never questions, speculation, pleasantries, or",
  "a restatement of what someone merely asked. Prefer FEW, high-value entries (0–3 is typical; an empty array is a",
  "correct answer). Do not wrap the JSON in prose or code fences.",
].join("\n");

// One validated extraction candidate (the model's raw item, tightened at the boundary).
export interface ExtractionCandidate {
  kind: KnowledgeEntryKind;
  title: string;
  body: string;
  refs: NodeRef[];
  confidence: number;
}

// Lenient boundary parse: take the outermost JSON array; per-item, require kind/title/body and keep only refs that
// validate against the closed vocabularies (a bad ref drops the REF, never the candidate). Caps the batch.
export function parseCandidates(text: string): ExtractionCandidate[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ExtractionCandidate[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PROPOSALS_PER_RUN) break;
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = KnowledgeEntryKindSchema.safeParse(o.kind);
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 300) : "";
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!kind.success || title === "" || body === "") continue;
    const refs: NodeRef[] = [];
    if (Array.isArray(o.refs)) {
      for (const r of o.refs) {
        const parsed = NodeRefSchema.safeParse(r);
        if (parsed.success) refs.push(parsed.data);
      }
    }
    const confidence = typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 0.6;
    out.push({ kind: kind.data, title, body, refs, confidence });
  }
  return out;
}

// The thread transcript the extractor reads — the root comment + its replies (1-level threading), timeline order.
export function renderThread(resourceType: string, resourceId: string, thread: CommentRecord[]): string {
  const lines = thread.map((c) => `${c.author}: ${c.body}`);
  return [`Discussion on ${resourceType} "${resourceId}":`, "", ...lines].join("\n");
}

export interface KnowledgeExtractionDeps {
  models: ModelRegistry;
  scopedSecretsFor: (tenant: string, subject?: string) => Promise<ScopedSecretTiers>;
  entries: KnowledgeEntryService;
  comments: CommentStore;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  // Test seam — replaces the registered-model transport path with a canned completion.
  completionFor?: (tenant: string, subject: string | undefined, model: string) => Promise<JudgeCompletion>;
}

export interface ExtractKnowledgeResult {
  proposals: KnowledgeEntryRecord[];
  skippedDuplicates: number;
  considered: number;
}

export class KnowledgeExtractionService {
  constructor(private readonly deps: KnowledgeExtractionDeps) {}

  async extract(
    tenant: string,
    subject: string | undefined,
    input: { source: { kind: "comment"; id: string }; model: string },
  ): Promise<ExtractKnowledgeResult> {
    // Resolve the thread: the input id may be any comment in it — hop to the root (1-level threading), then collect
    // the root + its replies from the resource's timeline-ordered comment list.
    const seed = await this.deps.comments.get(tenant, input.source.id);
    if (!seed) throw new NotFoundError("NOT_FOUND", { id: input.source.id }, "comment thread not found.");
    const root =
      seed.parentId !== undefined && seed.parentId !== ""
        ? ((await this.deps.comments.get(tenant, seed.parentId)) ?? seed)
        : seed;
    const all = await this.deps.comments.list(tenant, root.resourceType, root.resourceId);
    const thread = all.filter((c) => c.id === root.id || c.parentId === root.id);
    if (thread.length === 0) throw new NotFoundError("NOT_FOUND", { id: root.id }, "comment thread not found.");

    const complete = await this.resolveCompletion(tenant, subject, input.model);
    const prompt = `${SYSTEM_PROMPT}\n\n${renderThread(root.resourceType, root.resourceId, thread)}`;
    const candidates = parseCandidates(await complete(prompt)); // upstream failures already remapped to UpstreamError

    // Dedupe against entries already drawn from this thread (any status — a rejected duplicate re-proposing itself
    // on every run would defeat the review): same source + same title (case-insensitive) is the same claim.
    const existing = await this.deps.entries.list(tenant, subject ?? "");
    const seenTitles = new Set(
      existing.filter((e) => e.extraction?.sourceId === root.id).map((e) => e.title.trim().toLowerCase()),
    );

    // The discussed resource is a natural spatial anchor for every claim from this thread (unpinned = family-wide
    // unless the model pinned a version itself); the thread is the evidence.
    const resourceType = NodeTypeSchema.safeParse(root.resourceType);
    const resourceRef: NodeRef | undefined = resourceType.success
      ? { type: resourceType.data, key: root.resourceId }
      : undefined;

    const result: ExtractKnowledgeResult = { proposals: [], skippedDuplicates: 0, considered: candidates.length };
    for (const candidate of candidates) {
      if (seenTitles.has(candidate.title.trim().toLowerCase())) {
        result.skippedDuplicates += 1;
        continue;
      }
      const refs = [...candidate.refs];
      if (resourceRef && !refs.some((r) => r.type === resourceRef.type && r.key === resourceRef.key)) {
        refs.push(resourceRef);
      }
      const proposal = await this.deps.entries.propose({
        tenant,
        kind: candidate.kind,
        title: candidate.title,
        body: candidate.body,
        refs,
        evidence: [{ type: "comment", key: root.id }],
        extraction: {
          sourceKind: "comment",
          sourceId: root.id,
          extractor: KNOWLEDGE_EXTRACTOR,
          confidence: candidate.confidence,
        },
      });
      result.proposals.push(proposal);
    }
    return result;
  }

  // The registered-model completion (skill-generate's resolution path), unless the test seam replaced it.
  private async resolveCompletion(
    tenant: string,
    subject: string | undefined,
    model: string,
  ): Promise<JudgeCompletion> {
    if (this.deps.completionFor) return this.deps.completionFor(tenant, subject, model);
    const spec = await this.deps.models.get(tenant, model); // unknown model → NotFound (404)
    const secretName = modelApiKeySecretName(spec);
    const scoped = await this.deps.scopedSecretsFor(tenant, subject);
    const apiKey = scoped.workspace[secretName] ?? scoped.user[secretName];
    if (apiKey === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { secretName, model },
        `No API key resolved for '${secretName}' — set it in workspace or personal secrets, then extract again.`,
      );
    const envBaseUrl = spec.provider === "anthropic" ? this.deps.anthropicBaseUrl : this.deps.openaiBaseUrl;
    const baseUrl = spec.baseUrl ?? envBaseUrl;
    const transport = transportFor({
      provider: spec.provider,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    return transportComplete(transport, { model: spec.model, maxTokens: EXTRACT_MAX_TOKENS });
  }
}
