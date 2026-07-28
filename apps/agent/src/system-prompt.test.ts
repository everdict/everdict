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
});
