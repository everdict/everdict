import type { EnvSnapshot, GradeContext } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveJudgeArtifacts } from "./resolve-judge-artifacts.js";

const png = Buffer.from("PNGBYTES");
// A fetch that returns image bytes for *.png urls and text for everything else (like a real artifact store).
const artifactFetch = () =>
  vi.fn(async (u: string) => {
    const isPng = /\.png(\?|$)/i.test(String(u));
    return {
      ok: true,
      async arrayBuffer() {
        const b = isPng ? png : Buffer.from(`TEXT@${u}`);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      headers: { get: () => (isPng ? "image/png" : "text/plain") },
    };
  }) as unknown as typeof fetch;

const ctxWith = (snapshot: EnvSnapshot, evidence?: GradeContext["evidence"]): GradeContext => ({
  case: { id: "c", env: { kind: "browser", startUrl: "https://x" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  trace: [],
  snapshot,
  ...(evidence ? { evidence } : {}),
});

describe("resolveJudgeArtifacts — resolve every judge artifact URL to real data before the judge", () => {
  it("with image=true: fetches a browser snapshot's screenshotRef URL → embedded base64 (VLM input)", async () => {
    const f = artifactFetch();
    const out = await resolveJudgeArtifacts(
      ctxWith({
        kind: "browser",
        url: "https://x",
        dom: "<html></html>",
        screenshotRef: "https://store/r1.png",
        console: [],
      }),
      f,
      { image: true },
    );
    expect(out.snapshot.kind === "browser" && out.snapshot.screenshot).toBe(png.toString("base64"));
  });

  it("with image=false: does NOT fetch the screenshot (a text-only judge skips the large image)", async () => {
    const f = artifactFetch();
    const out = await resolveJudgeArtifacts(
      ctxWith({
        kind: "browser",
        url: "https://x",
        dom: "<html></html>",
        screenshotRef: "https://store/r1.png",
        console: [],
      }),
      f,
      { image: false },
    );
    expect(out.snapshot.kind === "browser" && out.snapshot.screenshot).toBeUndefined();
    expect(f).not.toHaveBeenCalled(); // dom is HTML (not a url), screenshot gated off → nothing to fetch
  });

  it("resolves a browser snapshot's dom that IS a url → the page's real text (always, no image gate)", async () => {
    const f = artifactFetch();
    const out = await resolveJudgeArtifacts(
      ctxWith({ kind: "browser", url: "https://x", dom: "https://store/page.html", console: [] }),
      f,
    );
    expect(out.snapshot.kind === "browser" && out.snapshot.dom).toBe("TEXT@https://store/page.html");
  });

  it("resolves os-use screenshotRef (image=true) and evidence.screenshotRef → bytes", async () => {
    const out = await resolveJudgeArtifacts(
      ctxWith(
        { kind: "os-use", screenshotRef: "https://store/os.png", screenshot: "", windows: [] },
        {
          screenshotRef: "https://store/ev.png",
        },
      ),
      artifactFetch(),
      { image: true },
    );
    expect(out.snapshot.kind === "os-use" && out.snapshot.screenshot).toBe(png.toString("base64"));
    expect(out.evidence?.screenshot).toBe(png.toString("base64"));
    expect(out.evidence?.screenshotMediaType).toBe("image/png");
  });

  it("resolves evidence.custom {name} slots that ARE urls → the artifact's text (the judge's template sees content, not a link)", async () => {
    const out = await resolveJudgeArtifacts(
      ctxWith(
        { kind: "prompt", output: "done" },
        {
          custom: { run_log: "https://store/log.txt", note: "just a plain note (not a url)" },
        },
      ),
      artifactFetch(),
    );
    expect(out.evidence?.custom?.run_log).toBe("TEXT@https://store/log.txt"); // fetched
    expect(out.evidence?.custom?.note).toBe("just a plain note (not a url)"); // left alone
  });

  it("returns the SAME ctx reference when nothing is a url (common no-op)", async () => {
    const f = artifactFetch();
    const ctx = ctxWith({ kind: "repo", diff: "", changedFiles: [], headSha: "h" }, { custom: { a: "plain" } });
    const out = await resolveJudgeArtifacts(ctx, f, { image: true });
    expect(out).toBe(ctx);
    expect(f).not.toHaveBeenCalled();
  });

  it("leaves an already-embedded screenshot untouched (no refetch)", async () => {
    const f = artifactFetch();
    const out = await resolveJudgeArtifacts(
      ctxWith({
        kind: "browser",
        url: "x",
        dom: "",
        screenshot: "ALREADY",
        screenshotRef: "https://x/s.png",
        console: [],
      }),
      f,
      { image: true },
    );
    expect(out.snapshot.kind === "browser" && out.snapshot.screenshot).toBe("ALREADY");
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps the url on a fetch miss (a missing artifact never fails the judge)", async () => {
    const failing = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    const out = await resolveJudgeArtifacts(
      ctxWith({ kind: "prompt", output: "x" }, { custom: { doc: "https://x/gone.txt" } }),
      failing,
    );
    expect(out.evidence?.custom?.doc).toBe("https://x/gone.txt"); // url kept
  });
});
