import type { IssueLabelColor, IssueLabelRecord, PlatformFact } from "@everdict/contracts";
import { BadRequestError } from "@everdict/contracts";

// The IssueLabel aggregate (docs/tracker.md) — the workspace's classification vocabulary. Transitions return
// {patch, facts} like Issue/Project/Initiative/Team, so the store persists state and its fact in one transaction
// (E0). Transitions must never be spread — always use .patch.
//
// A label is deliberately thin: it owns a name, a colour token and a description, and nothing about the issues
// that wear it. The join lives on the issue (`labelIds`), which is what makes a rename free — no issue is
// rewritten when a label changes its mind about what it is called.
export interface IssueLabelTransition {
  patch: Partial<IssueLabelRecord>;
  facts: PlatformFact[];
}

export interface NewIssueLabelInput {
  id: string;
  tenant: string;
  name: string;
  color: IssueLabelColor;
  description?: string;
  createdBy: string;
  now: string;
}

export interface IssueLabelEditInput {
  name?: string;
  color?: IssueLabelColor;
  description?: string | null;
}

// Names are compared case- and whitespace-insensitively so "Flaky", "flaky " and "flaky" cannot coexist. The
// STORED name keeps the author's casing (it is what a reader sees); only the comparison is folded — which is
// also the key a GitHub import matches a remote label name against.
export function normalizeIssueLabelName(raw: string): string {
  return raw.trim();
}

export function issueLabelNameKey(raw: string): string {
  return normalizeIssueLabelName(raw).toLocaleLowerCase();
}

export class IssueLabel {
  private constructor(private readonly record: IssueLabelRecord) {}

  static from(record: IssueLabelRecord): IssueLabel {
    return new IssueLabel(record);
  }

  static newLabel(input: NewIssueLabelInput): IssueLabelRecord {
    const name = normalizeIssueLabelName(input.name);
    if (name.length === 0) throw new BadRequestError("BAD_REQUEST", { name: input.name }, "A label needs a name.");
    return {
      id: input.id,
      tenant: input.tenant,
      name,
      color: input.color,
      ...(input.description !== undefined ? { description: input.description } : {}),
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: IssueLabelRecord): PlatformFact[] {
    return [
      {
        kind: "issue_label.created",
        subject: { type: "issue_label", id: record.id },
        actor: record.createdBy,
        payload: { name: record.name, color: record.color },
        message: `Label ${record.name} was defined.`,
      },
    ];
  }

  // Editing is content, not lifecycle — but a workspace's vocabulary changing IS news to anyone reading a board,
  // so it emits `updated` rather than staying silent. A no-op edit emits nothing and patches nothing.
  update(fields: IssueLabelEditInput, by: string, now: string): IssueLabelTransition {
    const patch: Partial<IssueLabelRecord> = {};
    const changed: string[] = [];

    if (fields.name !== undefined) {
      const name = normalizeIssueLabelName(fields.name);
      if (name.length === 0) throw new BadRequestError("BAD_REQUEST", { name: fields.name }, "A label needs a name.");
      if (name !== this.record.name) {
        patch.name = name;
        changed.push("name");
      }
    }
    if (fields.color !== undefined && fields.color !== this.record.color) {
      patch.color = fields.color;
      changed.push("color");
    }
    if (fields.description !== undefined) {
      const next = fields.description === null ? undefined : fields.description;
      if (next !== this.record.description) {
        patch.description = next;
        changed.push("description");
      }
    }
    if (changed.length === 0) return { patch: {}, facts: [] };

    return {
      patch: { ...patch, updatedAt: now },
      facts: [
        {
          kind: "issue_label.updated",
          subject: { type: "issue_label", id: this.record.id },
          actor: by,
          payload: { name: patch.name ?? this.record.name, changed },
          message: `Label ${patch.name ?? this.record.name} was updated.`,
        },
      ],
    };
  }

  // Deletion is not a patch — the store removes the row AND strips the id from every issue in the same
  // transaction, which is the invariant that keeps `labelIds` free of dangling pointers. The fact is computed
  // here so the message reads the same as every other label event.
  deletionFacts(by: string): PlatformFact[] {
    return [
      {
        kind: "issue_label.deleted",
        subject: { type: "issue_label", id: this.record.id },
        actor: by,
        payload: { name: this.record.name },
        message: `Label ${this.record.name} was deleted.`,
      },
    ];
  }
}
