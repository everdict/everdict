import process from "node:process";
import { JUDGE_MODEL_ENV, JUDGE_PROVIDER_ENV } from "@everdict/contracts";
import { transportFor } from "@everdict/llm";
import { transportComplete } from "./model-judge.js";

type Env = Record<string, string | undefined>;

// ── THE PERSON ON THE OTHER SIDE OF A DIALOGUE CASE (world-and-engagement-model.md, axis 2) ──────────
//
// A dialogue case's user is either data the case carries (scripted) or a MODEL playing a persona — the shape
// tau-bench and its relatives need, where what is measured is where the agent ends up after several
// exchanges with somebody who has their own goal.
//
// It lives here, beside the judge, because it is the same kind of thing: a model call this execution site was
// given credentials for, made on the platform's behalf and never on the agent's. Two consequences that are
// not incidental:
//   · the simulator speaks as the USER and is never handed the case's expected answer or its grading
//     material — a user who knows the answer stops being a user and becomes a hint;
//   · it ends the exchange by SAYING the stop sentence, and that turn is dropped rather than delivered, so
//     the transcript a judge reads carries no instruction the platform wrote.
export type SimulatedUser = (input: {
  persona: string;
  task: string;
  transcript: ReadonlyArray<{ role: string; text: string }>;
}) => Promise<string | undefined>;

// The brief. Deliberately small: the persona is the case author's, and everything else here is about staying
// in character and knowing when to stop.
export function userSimulatorPrompt(input: {
  persona: string;
  task: string;
  transcript: ReadonlyArray<{ role: string; text: string }>;
  done: string;
}): string {
  const exchange = input.transcript.map((t) => `${t.role === "assistant" ? "AGENT" : "YOU"}: ${t.text}`).join("\n\n");
  return [
    "You are a person talking to an assistant. Stay in character and answer as that person would.",
    "",
    "WHO YOU ARE AND WHAT YOU WANT:",
    input.persona,
    "",
    "WHAT YOU FIRST ASKED FOR:",
    input.task,
    "",
    "THE CONVERSATION SO FAR:",
    exchange.length > 0 ? exchange : "(the assistant has not replied yet)",
    "",
    "Write ONLY your next message — no narration, no quotes, no explanation of what you are doing.",
    "If what you wanted has been done, or the assistant has clearly failed and there is nothing left to try,",
    `reply with exactly ${input.done} and nothing else.`,
  ].join("\n");
}

// One completion per turn. `complete` is the same one-shot surface the model judge uses, so a deployment that
// can judge can also simulate — no second credential path, no second transport.
export function modelUser(complete: (prompt: string) => Promise<string>, opts: { done?: string } = {}): SimulatedUser {
  const done = opts.done ?? "###STOP###";
  return async ({ persona, task, transcript }) => {
    const said = await complete(userSimulatorPrompt({ persona, task, transcript, done }));
    const trimmed = said.trim();
    // The runner also checks for the stop sentence; checking it here too keeps a simulator usable on its own,
    // and an empty answer is the same ending — a user with nothing to say has stopped talking.
    return trimmed.length === 0 || trimmed.includes(done) ? undefined : said;
  };
}

// Configured from the SAME env the judge is (`EVERDICT_JUDGE_MODEL` + provider + key), because it is the same
// grant: a model call this job was given credentials for. Absent config = no simulator, and a case that
// declares a model user is then refused by name rather than run as a one-shot.
export function userSimulatorFromEnv(env: Env = process.env, opts: { done?: string } = {}): SimulatedUser | undefined {
  const model = env[JUDGE_MODEL_ENV];
  if (!model) return undefined;
  const provider = (env[JUDGE_PROVIDER_ENV] ?? "openai") === "anthropic" ? "anthropic" : "openai";
  const apiKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  const baseUrl = provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
  const transport = transportFor({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}) });
  // The SAME one-shot surface the model judge uses (`transportComplete`), so this credential path, its
  // fallback to `stream()` for a transport without `complete()`, and its error remapping are one
  // implementation rather than two spellings of it (rule `graders`).
  const complete = transportComplete(transport, { model });
  return modelUser(async (prompt) => complete(prompt), opts);
}
