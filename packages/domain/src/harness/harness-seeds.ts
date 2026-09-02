import { HARNESS_SEED_MOUNT } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

// ── THE BYTES A SEED NAMES (docs/architecture/harness-identity-and-seeds-spec.md §2) ─────────────────
//
// One owner for "what does a seed's digest cover": a skill seed digests the stamped version's instructions and
// files; a knowledge seed digests the entry's title and body. The harness author copies these from the skill /
// knowledge reads; the dispatch recomputes them from the records and refuses a mismatch.
export function skillSeedDigest(version: {
  instructions: string;
  files: ReadonlyArray<{ path: string; content: string }>;
}): string {
  return contentDigest({
    instructions: version.instructions,
    files: [...version.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, content: f.content })),
  });
}

export function knowledgeSeedDigest(entry: { title: string; body: string }): string {
  return contentDigest({ title: entry.title, body: entry.body });
}

export interface SeedFile {
  path: string;
  content: string;
}

// Where a seed lands inside the sandbox — a fixed mount every recipe can rely on (`{{seeds}}` in a command).
export function skillSeedFiles(
  id: string,
  version: { instructions: string; files: ReadonlyArray<{ path: string; content: string }> },
): SeedFile[] {
  return [
    { path: `${HARNESS_SEED_MOUNT}/skills/${id}/SKILL.md`, content: version.instructions },
    ...version.files.map((f) => ({ path: `${HARNESS_SEED_MOUNT}/skills/${id}/files/${f.path}`, content: f.content })),
  ];
}

export function knowledgeSeedFile(id: string, entry: { title: string; body: string }): SeedFile {
  return { path: `${HARNESS_SEED_MOUNT}/knowledge/${id}.md`, content: `# ${entry.title}\n\n${entry.body}` };
}
