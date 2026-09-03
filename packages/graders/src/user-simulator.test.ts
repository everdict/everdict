import { describe, expect, it } from "vitest";
import { modelUser, userSimulatorPrompt } from "./user-simulator.js";

// The person on the other side of a dialogue case. What matters here is what the simulator is TOLD and what
// it is not: it plays the user, so it never receives the case's expected answer or its grading material — a
// user who knows the answer stops being a user and becomes a hint.
describe("the simulated user's brief and its ending", () => {
  it("carries the persona, the original ask and the exchange — and nothing about how the case is graded", () => {
    const prompt = userSimulatorPrompt({
      persona: "you are booking for two and you hate aisles",
      task: "book me a flight",
      transcript: [
        { role: "assistant", text: "window or aisle?" },
        { role: "user", text: "window" },
      ],
      done: "###STOP###",
    });
    expect(prompt).toContain("you are booking for two and you hate aisles");
    expect(prompt).toContain("book me a flight");
    expect(prompt).toContain("AGENT: window or aisle?");
    expect(prompt).toContain("YOU: window");
    expect(prompt).toContain("###STOP###");
  });

  it("ends the exchange on the stop sentence or an empty answer, and passes anything else through", async () => {
    const answers = ["sure, make it a window", "###STOP###", "   "];
    let i = 0;
    const user = modelUser(async () => answers[i++] as string);
    const input = { persona: "p", task: "t", transcript: [] };
    expect(await user(input)).toBe("sure, make it a window");
    expect(await user(input)).toBeUndefined();
    expect(await user(input)).toBeUndefined();
  });

  it("says the empty transcript out loud rather than showing an empty section", () => {
    expect(userSimulatorPrompt({ persona: "p", task: "t", transcript: [], done: "X" })).toContain(
      "the assistant has not replied yet",
    );
  });
});
