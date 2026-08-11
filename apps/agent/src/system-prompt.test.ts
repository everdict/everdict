import { describe, expect, it } from "vitest";
import { buildEnvironmentSection } from "./system-prompt.js";

describe("buildEnvironmentSection", () => {
  it("carries the web base as deep-link guidance and the desktop download page (trailing slash normalized)", () => {
    const section = buildEnvironmentSection({
      workspace: "acme",
      model: "m1",
      date: "2026-07-27",
      webBaseUrl: "http://web.test/",
    });
    expect(section).toContain("- Web app: http://web.test —");
    expect(section).toContain("http://web.test/acme/<resource>/<id>");
    expect(section).toContain("download page http://web.test/acme/download");
    expect(section).not.toContain("direct "); // no operator direct-download URL set
  });

  it("offers the direct download URL alongside the in-app page when the operator set one", () => {
    const section = buildEnvironmentSection({
      workspace: "acme",
      model: "m1",
      date: "2026-07-27",
      webBaseUrl: "http://web.test",
      desktopDownloadUrl: "https://github.com/acme/everdict/releases/latest",
    });
    expect(section).toContain("· direct https://github.com/acme/everdict/releases/latest");
  });

  it("omits every link line without a web base URL — the agent must not guess URLs", () => {
    const section = buildEnvironmentSection({ workspace: "acme", model: "m1", date: "2026-07-27" });
    expect(section).not.toContain("Web app");
    expect(section).not.toContain("download");
  });

  it("renders the date at day precision so the system prompt stays byte-identical across a day's turns", () => {
    // Regression: the caller hands in a millisecond ISO timestamp (deps.now()); rendering it verbatim made every
    // turn's system prompt unique, invalidating the provider's prompt-cache prefix on every single call.
    const at = buildEnvironmentSection({ workspace: "acme", model: "m1", date: "2026-08-06T01:23:45.678Z" });
    expect(at).toContain("- Date: 2026-08-06");
    expect(at).not.toContain("01:23:45");
    // Two turns on the same day produce the same block
    const later = buildEnvironmentSection({ workspace: "acme", model: "m1", date: "2026-08-06T09:00:00.000Z" });
    expect(later).toBe(at);
    // A date-only value passes through untouched
    expect(buildEnvironmentSection({ workspace: "acme", model: "m1", date: "2026-07-27" })).toContain(
      "- Date: 2026-07-27",
    );
  });

  it("names the conversation's task directory so each task's files stay separated on the filesystem", () => {
    const section = buildEnvironmentSection({
      workspace: "acme",
      model: "m1",
      date: "2026-07-27",
      taskDirectory: "tasks/sess-1",
    });
    expect(section).toContain("- Task directory: tasks/sess-1 —");
    const bare = buildEnvironmentSection({ workspace: "acme", model: "m1", date: "2026-07-27" });
    expect(bare).not.toContain("Task directory"); // sessionless callers (try/preview) get no task area
  });

  // The prompt promises tools over the whole platform. When that promise cannot be kept, the turn has to say so —
  // otherwise the model answers about a workspace it never read, which is the failure this line exists to prevent.
  it("declares WHY the platform tools are missing when they are, and stays silent when they are not", () => {
    const degraded = buildEnvironmentSection({
      workspace: "acme",
      model: "m1",
      date: "2026-07-27",
      platformToolsError: "could not reach the control plane's MCP at http://api:8787/mcp: HTTP 401",
    });
    expect(degraded).toContain("platform tools are UNAVAILABLE this turn");
    expect(degraded).toContain("http://api:8787/mcp: HTTP 401"); // the reason travels verbatim, not a euphemism
    expect(degraded).toContain("never claim a change was made");
    const healthy = buildEnvironmentSection({ workspace: "acme", model: "m1", date: "2026-07-27" });
    expect(healthy).not.toContain("UNAVAILABLE");
  });
});
