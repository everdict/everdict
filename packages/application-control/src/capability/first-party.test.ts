import { CapabilityRecordSchema, FIRST_PARTY_TENANT } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  WEBSEARCH_SECRET_NAME,
  firstPartyCatalogExtras,
  firstPartyDefaults,
  firstPartySkillExamples,
} from "./first-party.js";

describe("firstPartyDefaults", () => {
  const defaults = firstPartyDefaults();

  it("every seed is a valid, first-party, public CapabilityRecord", () => {
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) {
      const parsed = CapabilityRecordSchema.parse(d.record); // throws on any drift from the contract
      expect(parsed.tenant).toBe(FIRST_PARTY_TENANT);
      expect(parsed.visibility).toBe("public"); // browsable/adoptable in the store too
    }
  });

  it("ships a web-search code tool that declares the search-key secret", () => {
    const web = defaults.find((d) => d.record.id === "web-search");
    expect(web).toBeDefined();
    if (!web) return;
    expect(web.requires).toBeNull(); // unconditional (not integration-gated)
    expect(web.record.spec.type).toBe("code");
    if (web.record.spec.type !== "code") return;
    expect(web.record.spec.requiredSecrets.map((s) => s.name)).toContain(WEBSEARCH_SECRET_NAME);
    expect(web.record.spec.isReadOnly).toBe(true);
  });

  it("ships a fetch_url code tool that needs no secret and is HITL-gated (arbitrary-URL fetch)", () => {
    const fetchUrl = defaults.find((d) => d.record.id === "fetch-url");
    expect(fetchUrl).toBeDefined();
    if (!fetchUrl) return;
    expect(fetchUrl.requires).toBeNull(); // unconditional
    expect(fetchUrl.record.spec.type).toBe("code");
    if (fetchUrl.record.spec.type !== "code") return;
    expect(fetchUrl.record.spec.requiredSecrets).toEqual([]); // no key → always offered
    expect(fetchUrl.record.spec.isReadOnly).toBe(false); // arbitrary URL fetch → HITL-gated (SSRF guardrail)
  });

  it("attaches TOOLS only — a skill is a document a workspace owns, so it is never a silent default", () => {
    for (const d of defaults) expect(["code", "mcp"]).toContain(d.record.spec.type);
  });

  it("ships a pdf-read code tool that needs no secret and is HITL-gated (arbitrary-URL fetch)", () => {
    const pdf = defaults.find((d) => d.record.id === "pdf-read");
    expect(pdf).toBeDefined();
    if (!pdf) return;
    expect(pdf.requires).toBeNull(); // unconditional
    expect(pdf.record.spec.type).toBe("code");
    if (pdf.record.spec.type !== "code") return;
    expect(pdf.record.spec.requiredSecrets).toEqual([]); // no key → always offered
    expect(pdf.record.spec.isReadOnly).toBe(false); // arbitrary URL fetch → HITL-gated
  });
});

describe("firstPartySkillExamples", () => {
  const examples = firstPartySkillExamples();

  it("are store entries a workspace COPIES, never defaults attached to anyone's agent", () => {
    const defaultIds = new Set(firstPartyDefaults().map((d) => d.record.id));
    const catalogIds = new Set(firstPartyCatalogExtras().map((r) => r.id));
    expect(examples.length).toBeGreaterThan(0);
    for (const rec of examples) {
      const parsed = CapabilityRecordSchema.parse(rec);
      expect(parsed.spec.type).toBe("skill");
      expect(parsed.tenant).toBe(FIRST_PARTY_TENANT);
      expect(parsed.visibility).toBe("public"); // browsable by every workspace
      expect(defaultIds.has(parsed.id)).toBe(false); // NOT auto-attached — the whole point
      expect(catalogIds.has(parsed.id)).toBe(true); // reachable exactly one way: the store catalog
    }
  });

  it("the scorecard-fix-PR example carries the diagnose→PR procedure and its PR-body reference file", () => {
    const skill = examples.find((r) => r.id === "scorecard-fix-pr");
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    // The procedure's load-bearing steps: diagnose from scorecard evidence, fix via a PR, and carry the experiment
    // context in the PR body (the whole point of the skill — a reviewer judges the fix without re-running).
    for (const anchor of ["get_scorecard", "get_github_file", "open_github_pr", "references/pr-body.md"]) {
      expect(skill.spec.instructions).toContain(anchor);
    }
    // The mandatory PR-body structure lives in a supporting file (progressive disclosure: loaded via read_skill_file
    // only at the PR step), keeping the body lean.
    const prBody = skill.spec.files.find((f) => f.path === "references/pr-body.md");
    expect(prBody).toBeDefined();
    for (const anchor of ["What failed", "Failing cases", "Root cause", "Verification"]) {
      expect(prBody?.content).toContain(anchor);
    }
  });

  it("the trace-analysis example carries the pull→attribute→report procedure and its report reference file", () => {
    const skill = examples.find((r) => r.id === "trace-analysis");
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    for (const anchor of ["inspect_trace", "list_trace_source_traces", "provenance", "references/report.md"]) {
      expect(skill.spec.instructions).toContain(anchor);
    }
    const report = skill.spec.files.find((f) => f.path === "references/report.md");
    expect(report).toBeDefined();
    for (const anchor of ["Verdict", "Failures", "Cost & latency", "Next steps"]) {
      expect(report?.content).toContain(anchor);
    }
  });
});

describe("firstPartyCatalogExtras", () => {
  const extras = firstPartyCatalogExtras();

  it("every catalog entry is a valid, first-party, public CapabilityRecord that is NOT a default (adopt-only)", () => {
    const defaultIds = new Set(firstPartyDefaults().map((d) => d.record.id));
    for (const rec of extras) {
      const parsed = CapabilityRecordSchema.parse(rec); // throws on any drift from the contract
      expect(parsed.tenant).toBe(FIRST_PARTY_TENANT);
      expect(parsed.visibility).toBe("public"); // browsable/adoptable in the store
      expect(defaultIds.has(parsed.id)).toBe(false); // catalog-only — never auto-enabled
    }
  });

  it("seeds containerized (image-transport) MCP servers — every one declares an image and no url", () => {
    for (const id of ["grafana", "playwright", "postgres"]) {
      const rec = extras.find((r) => r.id === id);
      expect(rec, id).toBeDefined();
      if (!rec || rec.spec.type !== "mcp") continue;
      expect(rec.spec.image, id).toBeTruthy(); // container-image transport
      expect(rec.spec.url, id).toBeUndefined(); // NOT an HTTP server
    }
  });

  it("ships the Grafana MCP server with the two Grafana env secrets and the -t stdio arg", () => {
    const grafana = extras.find((r) => r.id === "grafana");
    if (!grafana || grafana.spec.type !== "mcp") throw new Error("grafana seed missing");
    expect(grafana.spec.image).toBe("grafana/mcp-grafana");
    expect(grafana.spec.args).toEqual(["-t", "stdio"]); // the image defaults to SSE; -t stdio selects stdio
    expect(grafana.spec.requiredSecrets.map((s) => s.name)).toEqual(["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"]);
    expect(grafana.spec.write).toBe(false);
  });

  it("pins Postgres MCP Pro to read-only restricted access mode and binds DATABASE_URI", () => {
    const pg = extras.find((r) => r.id === "postgres");
    if (!pg || pg.spec.type !== "mcp") throw new Error("postgres seed missing");
    expect(pg.spec.image).toBe("crystaldba/postgres-mcp");
    expect(pg.spec.args).toContain("--access-mode=restricted"); // never mutates the DB
    expect(pg.spec.requiredSecrets.map((s) => s.name)).toEqual(["DATABASE_URI"]);
  });

  it("ships Playwright as a no-secret browser server (write-capable, adopter opts in)", () => {
    const pw = extras.find((r) => r.id === "playwright");
    if (!pw || pw.spec.type !== "mcp") throw new Error("playwright seed missing");
    expect(pw.spec.image).toBe("mcr.microsoft.com/playwright/mcp");
    expect(pw.spec.requiredSecrets).toEqual([]); // no credentials — ephemeral headless chromium
    expect(pw.spec.write).toBe(true); // navigate/click/type are actions → bridged only on enableWrite
  });
});
