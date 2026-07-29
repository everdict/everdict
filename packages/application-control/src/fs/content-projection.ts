import type { FsActor, SkillFile } from "@everdict/contracts";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

// Skill + knowledge-entry content on the workspace filesystem — the SSOT layout every surface shares (the web
// Files page browses it, the shell cats it, agents read/write it with the fs tools):
//   skills/<id>/SKILL.md       — the skill's instructions (the SKILL.md body)
//   skills/<id>/files/<path>   — each supporting file
//   knowledge/<id>.md          — a knowledge entry's markdown body
// The DB rows keep a full replica for processes without filesystem access (and as the pre-filesystem fallback);
// the services write the filesystem FIRST (a failed projection fails the save — no silently stale SSOT) and read
// it FIRST, lazily migrating legacy rows onto it and re-syncing the replica when the filesystem was edited
// out-of-band (shell/agent). See docs in the service classes.

export function skillDir(id: string): string {
  return `skills/${id}`;
}
export function skillInstructionsPath(id: string): string {
  return `skills/${id}/SKILL.md`;
}
export function skillFilePath(id: string, relative: string): string {
  return `skills/${id}/files/${relative}`;
}
export function knowledgeEntryPath(id: string): string {
  return `knowledge/${id}.md`;
}

// Saved-View snapshots accumulate under one directory per View:
//   views/<viewId>/<capturedAt>.json
// Path segments allow only [A-Za-z0-9._-], so the instant is stamped without the ISO colons. Sorting the
// directory by name therefore sorts it by time, which is what makes the accumulation browsable as-is.
export function viewSnapshotDir(viewId: string): string {
  return `views/${viewId}`;
}
export function viewSnapshotPath(viewId: string, capturedAt: string): string {
  return `views/${viewId}/${snapshotStamp(capturedAt)}.json`;
}

// "2026-07-29T14:45:00.123Z" → "2026-07-29T14-45-00Z". Second resolution: two captures inside one second
// would collide, and a write is create-or-replace, so the later one wins — an acceptable trade for a name a
// human can read, since captures are driven by people and schedules, not by a loop.
export function snapshotStamp(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SkillContent {
  instructions: string;
  files: SkillFile[];
}

// Replace a skill's whole filesystem projection (instructions + supporting files). Full replacement — a lingering
// file from a previous version would otherwise resurface on read.
//
// `actor` is who saved the skill. Without it the projection publishes as `system`, and the file's history would
// credit nobody for an edit a person (or an agent) actually made — the same SKILL.md is editable from Settings,
// from the shell and by agents, so all three have to land in one comparable history.
export async function writeSkillContent(
  fs: WorkspaceFs,
  tenant: string,
  id: string,
  content: SkillContent,
  actor?: FsActor,
): Promise<void> {
  const opts = actor ? { actor } : undefined;
  await fs.remove(tenant, skillDir(id), { recursive: true }); // 0 when absent — fine
  await fs.write(
    tenant,
    skillInstructionsPath(id),
    encoder.encode(content.instructions),
    "text/markdown; charset=utf-8",
    opts,
  );
  for (const file of content.files) {
    await fs.write(tenant, skillFilePath(id, file.path), encoder.encode(file.content), undefined, opts);
  }
}

// A skill's content as the filesystem holds it — undefined when the skill has no projection yet (legacy row).
export async function readSkillContent(fs: WorkspaceFs, tenant: string, id: string): Promise<SkillContent | undefined> {
  const main = await fs.read(tenant, skillInstructionsPath(id));
  if (!main) return undefined;
  const filesRoot = `${skillDir(id)}/files`;
  const files: SkillFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.list(tenant, dir)) {
      if (entry.kind === "dir") await walk(entry.path);
      else {
        const file = await fs.read(tenant, entry.path);
        if (file) files.push({ path: entry.path.slice(filesRoot.length + 1), content: decoder.decode(file.data) });
      }
    }
  };
  await walk(filesRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { instructions: decoder.decode(main.data), files };
}

export async function removeSkillContent(fs: WorkspaceFs, tenant: string, id: string): Promise<void> {
  await fs.remove(tenant, skillDir(id), { recursive: true });
}

export function skillContentEquals(a: SkillContent, b: SkillContent): boolean {
  if (a.instructions !== b.instructions || a.files.length !== b.files.length) return false;
  const byPath = new Map(a.files.map((f) => [f.path, f.content]));
  return b.files.every((f) => byPath.get(f.path) === f.content);
}

export async function writeKnowledgeBody(
  fs: WorkspaceFs,
  tenant: string,
  id: string,
  body: string,
  actor?: FsActor,
): Promise<void> {
  await fs.write(
    tenant,
    knowledgeEntryPath(id),
    encoder.encode(body),
    "text/markdown; charset=utf-8",
    actor ? { actor } : undefined,
  );
}

export async function readKnowledgeBody(fs: WorkspaceFs, tenant: string, id: string): Promise<string | undefined> {
  const file = await fs.read(tenant, knowledgeEntryPath(id));
  return file ? decoder.decode(file.data) : undefined;
}

export async function removeKnowledgeBody(fs: WorkspaceFs, tenant: string, id: string): Promise<void> {
  await fs.remove(tenant, knowledgeEntryPath(id), { recursive: false });
}
