import type OpenAI from "openai";
import type { ChatMessage } from "../messages.js";
import { streamChat } from "./stream-chat.js";

// The compaction digest prompt — a condensed take on Claude Code's structured-summary template. The point is to
// preserve what a long task can't afford to lose across a compaction boundary: the user's goal, the concrete state,
// and what's still pending. TEXT ONLY — the summariser must never call tools.
const SUMMARY_SYSTEM_PROMPT = [
  "You are compacting a long agent conversation to fit the context window. Read the conversation and write a concise",
  "but complete summary that lets the agent continue WITHOUT the original messages. Preserve concrete detail — ids,",
  "file/resource names, decisions, and exact user asks — over prose. Use these sections (omit any that are empty):",
  "",
  "1. Goal — what the user is ultimately trying to accomplish (their original intent, verbatim where possible).",
  "2. Key facts & decisions — concrete findings, ids/names, and choices made so far.",
  "3. Actions taken — which tools were called and what they returned (the outcome, not the raw payload).",
  "4. Errors & fixes — anything that failed and how it was resolved (so it isn't retried blindly).",
  "5. Pending — what still needs to happen to finish the goal.",
  "6. Current state — precisely what was being worked on right before this summary.",
  "",
  "Output ONLY the summary. Do not call tools. Do not add commentary before or after.",
].join("\n");

// Build a summariser bound to the loop's own model — a single non-tool completion that digests the old span. Reused by
// runAgentLoop for rung-2 (LLM) compaction; tests inject their own summariser instead.
export function buildSummarizer(client: OpenAI, model: string): (oldSpan: ChatMessage[]) => Promise<string> {
  return async (oldSpan) => {
    const result = await streamChat({
      client,
      model,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        ...oldSpan,
        { role: "user", content: "Summarise the conversation above per the instructions. Text only, no tools." },
      ],
    });
    return result.content ?? "";
  };
}
