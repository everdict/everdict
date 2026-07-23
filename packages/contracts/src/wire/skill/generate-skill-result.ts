import { z } from "zod";

// POST /skills/generate 200 — an AI-drafted skill (skill-generate). The model turns a natural-language description
// into a SKILL.md-style draft the member then edits and saves; nothing is persisted by generation itself.
export const GenerateSkillResultSchema = z.object({
  name: z.string().describe("A short, kebab-case skill name (e.g. scorecard-triage)"),
  description: z.string().describe("One line — when to use this skill / what it does"),
  instructions: z.string().describe("The SKILL.md body — the numbered procedure the agent follows"),
});
export type GenerateSkillResult = z.infer<typeof GenerateSkillResultSchema>;
