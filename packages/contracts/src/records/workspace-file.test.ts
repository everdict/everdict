import { describe, expect, it } from "vitest";
import { fsFileClassOf, guessFsContentType, isFsTextContentType } from "./workspace-file.js";

describe("guessFsContentType — breadth over the office + development long tail", () => {
  it("types office deliverables so they are never mistaken for opaque blobs", () => {
    expect(guessFsContentType("reports/q3.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(guessFsContentType("data/budget.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(guessFsContentType("deck.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(guessFsContentType("plan.hwp")).toBe("application/x-hwp");
  });

  it("gives source files a text/* type, so every language is text-detectable without an allowlist entry", () => {
    for (const path of ["main.go", "lib.rs", "App.java", "server.rb", "query.sql", "deploy.sh", "main.tsx"]) {
      expect(isFsTextContentType(guessFsContentType(path))).toBe(true);
    }
    expect(guessFsContentType("main.go")).toBe("text/x-go; charset=utf-8");
    expect(guessFsContentType("deploy.sh")).toBe("text/x-shellscript; charset=utf-8");
  });

  it("resolves extension-less files by name", () => {
    expect(guessFsContentType("Dockerfile")).toBe("text/x-dockerfile; charset=utf-8");
    expect(guessFsContentType("build/Makefile")).toBe("text/x-makefile; charset=utf-8");
    expect(guessFsContentType("LICENSE")).toBe("text/plain; charset=utf-8");
  });

  it("treats dotfiles as configuration text, including the ones whose suffix looks like an extension", () => {
    expect(guessFsContentType(".gitignore")).toBe("text/plain; charset=utf-8");
    expect(guessFsContentType(".env.local")).toBe("text/plain; charset=utf-8");
    // A dotfile with a KNOWN extension still resolves by extension.
    expect(guessFsContentType(".eslintrc.json")).toBe("application/json");
  });

  it("falls back to an opaque blob only for genuinely unknown extensions", () => {
    expect(guessFsContentType("model.wjqx")).toBe("application/octet-stream");
    expect(guessFsContentType("noextension")).toBe("application/octet-stream");
  });
});

describe("isFsTextContentType — the encoding axis (can it round-trip as utf-8?)", () => {
  it("accepts text/*, structured suffixes and the textual application/* types", () => {
    expect(isFsTextContentType("text/x-rust; charset=utf-8")).toBe(true);
    expect(isFsTextContentType("application/x-ipynb+json")).toBe(true);
    expect(isFsTextContentType("image/svg+xml")).toBe(true);
    expect(isFsTextContentType("application/toml")).toBe(true);
    expect(isFsTextContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("rejects binary containers, including the ones with a structured suffix", () => {
    expect(isFsTextContentType("application/epub+zip")).toBe(false);
    expect(isFsTextContentType("application/pdf")).toBe(false);
    expect(isFsTextContentType("application/octet-stream")).toBe(false);
  });
});

describe("fsFileClassOf — the presentation axis (how does it want to be rendered?)", () => {
  it("classifies each medium", () => {
    expect(fsFileClassOf("image/png")).toBe("image");
    expect(fsFileClassOf("audio/mpeg")).toBe("audio");
    expect(fsFileClassOf("video/mp4")).toBe("video");
    expect(fsFileClassOf("application/pdf")).toBe("pdf");
    expect(fsFileClassOf("application/zip")).toBe("archive");
    expect(fsFileClassOf("text/x-go; charset=utf-8")).toBe("text");
    expect(fsFileClassOf("application/octet-stream")).toBe("binary");
  });

  it("keeps office documents apart from opaque binaries — they are readable deliverables, just not inline", () => {
    expect(fsFileClassOf(guessFsContentType("q3.xlsx"))).toBe("document");
    expect(fsFileClassOf(guessFsContentType("report.hwp"))).toBe("document");
    expect(fsFileClassOf(guessFsContentType("model.bin"))).toBe("binary");
  });

  it("puts svg on both axes: an image to render, still text to edit", () => {
    expect(fsFileClassOf("image/svg+xml")).toBe("image");
    expect(isFsTextContentType("image/svg+xml")).toBe(true);
  });
});
