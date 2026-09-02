import { CapabilityRecordSchema, FIRST_PARTY_TENANT } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  WEBSEARCH_SECRET_NAME,
  firstPartyCatalogExtras,
  firstPartyDefaults,
  firstPartyDelegationExamples,
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

  it("the agent-evolve example carries the baseline→mutate→diff→adopt campaign and its statistical discipline", () => {
    const skill = examples.find((r) => r.id === "agent-evolve");
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    // The loop's load-bearing steps: shadow tries as trials, an ingested baseline, a significance-gated diff,
    // and adoption as a saved immutable version — plus the two disciplines that keep it honest (a measured
    // noise floor before any delta is read; never touching the oracle mid-campaign).
    for (const anchor of [
      "try_agent",
      "ingest_scorecard",
      "diff_scorecards",
      "save_agent",
      "NOISE FLOOR",
      "one hypothesis per round",
      "NEVER weaken judges",
      "references/campaign-log.md",
    ]) {
      expect(skill.spec.instructions).toContain(anchor);
    }
    const log = skill.spec.files.find((f) => f.path === "references/campaign-log.md");
    expect(log).toBeDefined();
    for (const anchor of ["Frame", "Noise floor", "Rounds", "Close"]) {
      expect(log?.content).toContain(anchor);
    }
  });

  // ── A PROCEDURE THAT OPENS A CAMPAIGN AND NEVER LOGS A ROUND CANNOT CLOSE ONE ─────────────────────
  //
  // The campaign RECORD landed ten days after this procedure was drilled, and the copy was then given three
  // of the six doors — open, settle, adopt — and never the two that make a campaign move. `campaignAdoption`
  // answers `continue` on an empty round trace and `settle` refuses `continue`, so every campaign the skill
  // opened would have stayed open forever, with the failure appearing three steps away from the omission.
  //
  // Anchors alone would not have caught it: the four doors that WERE named read as coverage. So the
  // assertion is derived — every campaign door the body names must also be in the `select:` preload, which
  // is the line that decides whether the agent can call it at all. Pre-fix that fails naming all four.
  // ⚠️ AND IT RUNS OVER EVERY EVOLVE PROCEDURE, NOT THE ONE THAT WAS BROKEN. The defect above was a lane
  // taught in four of six places; writing its regression for a single skill id would leave the NEXT
  // procedure — `harness-evolve`, added one wave later against the same doors — free to repeat it exactly,
  // with nothing to grep because the two skills share no symbol (rule `protocol`, the one-lane-only law).
  it.each(["agent-evolve", "harness-evolve"])(
    "the %s example drives the campaign record, and preloads every door it names",
    (id) => {
      const skill = examples.find((r) => r.id === id);
      expect(skill).toBeDefined();
      if (!skill || skill.spec.type !== "skill") return;
      const body = skill.spec.instructions;

      // The two the agent procedure was missing are the two that move a campaign: one records the evidence,
      // the other asks the frozen frame what to do with it.
      for (const door of [
        "open_campaign",
        "log_campaign_round",
        "campaign_decision",
        "settle_campaign",
        "campaign_adoption",
        "adopt_campaign_candidate",
      ]) {
        expect(body, `${id} must name ${door}`).toContain(door);
      }

      // Everdict's tools load on demand, so a door named in prose and absent from the preload is a door the
      // agent has to go looking for mid-walk. Derived from the body rather than restated.
      const select = /select:([a-z_,]+)/.exec(body)?.[1];
      expect(select, `${id} must open with a ToolSearch preload`).toBeDefined();
      const preloaded = new Set((select ?? "").split(","));
      const DOOR =
        /^(open_campaign|log_campaign_round|settle_campaign|campaign_(decision|adoption)|adopt_campaign_candidate)$/;
      const named = [...body.matchAll(/\b([a-z_]*campaign[a-z_]*)\b/g)]
        .map((m) => m[1])
        .filter((word): word is string => word !== undefined && DOOR.test(word));
      expect(named.length).toBeGreaterThan(0); // the derivation must actually reach something
      for (const door of new Set(named)) {
        expect(preloaded.has(door), `${id}: ${door} is named but not preloaded`).toBe(true);
      }

      // Both procedures pre-register their statistics: the held-out rows are tested once per ROUND and the
      // frame declares the family that correction is spread over. A procedure that skips this authors frames
      // whose rounds a tightened `campaignFrameDefects` refuses.
      expect(body, `${id} must tell the frame to declare its family`).toContain("heldOutFamilySize");

      // ── AND BOTH CARRY THE KNOWLEDGE LAYER, WITH ITS ONE PROHIBITION ─────────────────────────────
      //
      // `learned` is required by both doors, so a procedure that never mentions it authors 400s. The
      // prohibition matters more than the field: findings feed the PROPOSAL and must not reach the subject
      // being measured. WikiSkill measured that inversion at −2.8 points against +15.0 for the proposer
      // alone, and it is the same law as never touching the oracle mid-campaign — which is exactly why it
      // is asserted on both procedures rather than on the one that happened to be written first.
      expect(body, `${id} must name the required finding`).toContain("learned");
      expect(body, `${id} must forbid feeding findings to the subject`).toContain("NEVER RECEIVES THE FINDINGS");
    },
  );

  it("the agent-evolve example asks the gate rather than restating it", () => {
    const skill = examples.find((r) => r.id === "agent-evolve");
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    const body = skill.spec.instructions;

    // …and the gate is ASKED, not restated. The prose used to carry its own adoption predicate over
    // whole-round counts while the gate reads the held-out ones — a predicate written twice that had
    // already diverged (rule `protocol` L3).
    expect(body).toContain("HELD-OUT");
    expect(body).not.toContain("Adopt only when ALL hold");

    // The drill's own arithmetic: at N=3 a total flip is Fisher p = 0.10, so the old "at least 3" default
    // authored rounds that could not produce a significant result whatever the candidate did.
    expect(body).toContain("N is at least 5");
  });

  // ── THE SUBJECT THIS PRODUCT IS ACTUALLY ABOUT ──────────────────────────────────────────────────────
  //
  // `CampaignSubject.type` is `agent | harness` and only the agent half had a procedure, which is backwards:
  // everdict evaluates harnesses, and the agent loop is the reference owner runtime pointed at itself.
  //
  // The load-bearing difference is evidentiary, so that is what is asserted. A harness round is a REAL batch
  // — submit seals `harness.specDigest` and every case records the image bytes it ran from — so identity is
  // `exact`, the world axis reads held, and NEITHER waiver belongs on the frame. A procedure that reached for
  // one would be papering over a broken batch with a frozen declaration nobody can withdraw.
  it("the harness-evolve example runs real batches, and tells you the waivers are not the repair", () => {
    const skill = examples.find((r) => r.id === "harness-evolve");
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    const body = skill.spec.instructions;

    // The harness lane's own doors: a candidate is an INSTANCE it registers, and the evaluation is a batch.
    for (const anchor of [
      "register_harness",
      "pin_harness_images",
      "diff_harness_versions",
      "run_scorecard",
      "references/levers.md",
      "NOISE FLOOR",
    ]) {
      expect(body).toContain(anchor);
    }

    // The waivers are NAMED so the procedure can refuse them, and the refusal names what to fix instead.
    expect(body).toContain("allowLabelOnlyAdoption");
    expect(body).toContain("allowUnverifiedIdentity");
    expect(body).toContain("the BATCH is wrong, not the frame");

    // …and the levers file carries the half that reads like a trap: moving the scaffold is the treatment,
    // and the world axis compares the TASK container, which no harness pin touches.
    const levers = skill.spec.files.find((f) => f.path === "references/levers.md");
    expect(levers).toBeDefined();
    for (const anchor of ["pins.model", "template.version", "execution_world", "What IS a confound"]) {
      expect(levers?.content).toContain(anchor);
    }
  });

  it("the memory-consolidation example carries the orient→gather→consolidate→prune pass over memory/", () => {
    const skill = examples.find((r) => r.id === "memory-consolidation");
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    // The pass's load-bearing rules: walk memory/ with the ordinary fs tools, merge instead of duplicating,
    // move entity facts to the knowledge layer, write with the optimistic lock, and never invent.
    for (const anchor of [
      "memory/MEMORY.md",
      "search_files",
      "update, don't duplicate",
      "create_knowledge_entry",
      "base_revision",
      "never invention",
    ]) {
      expect(skill.spec.instructions).toContain(anchor);
    }
    // Scheduling guidance is the description's job — the store card is where a member decides how to run it.
    expect(skill.description).toContain("schedule.fired");
  });

  it("the delegate-work example names the real delegation tools, the deferred-tool step, and the verify-before-report rule", () => {
    const skill = examples.find((r) => r.id === "delegate-work");
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    // Tool names are the one thing nothing else validates — a typo here ships a skill that tells the agent to
    // call something that does not exist. Every name below is a registered MCP tool (apps/api/src/api/**.mcp.ts).
    for (const anchor of [
      "ToolSearch", // MCP tools are deferred — without this step the agent cannot call any of them
      "list_public_capabilities",
      "create_sandbox",
      "submit_sandbox_task",
      "read_sandbox_task_trace",
      "sandbox_exec",
      "sandbox_git_push",
      "snapshot_sandbox",
      "close_sandbox",
      "run_scorecard",
      "diff_scorecards", // NOT get_scorecard_diff — that tool does not exist
      "references/brief.md",
    ]) {
      expect(skill.spec.instructions, anchor).toContain(anchor);
    }
    // The discipline the skill exists to install: the delegator owns the outcome and verifies it.
    expect(skill.spec.instructions).toContain("Never report work as done that you did not verify yourself");
    // The guarded action is called out — the agent must warn the member before the approval prompt appears.
    expect(skill.spec.instructions).toContain("GUARDED");
    // The brief's quality bar is progressive-disclosure (loaded at the step that writes one).
    const brief = skill.spec.files.find((f) => f.path === "references/brief.md");
    expect(brief).toBeDefined();
    for (const anchor of ["goal", "context", "references", "constraints", "doneWhen"]) {
      expect(brief?.content, anchor).toContain(anchor);
    }
  });
});

describe("firstPartyDelegationExamples", () => {
  const examples = firstPartyDelegationExamples();

  it("ships a delegation profile as an ADOPTABLE example — the environment a workspace delegates into is theirs to define", () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const rec of examples) {
      const parsed = CapabilityRecordSchema.parse(rec);
      expect(parsed.spec.type).toBe("delegation");
      expect(parsed.visibility).toBe("public");
      expect(parsed.tags).toContain("example"); // copied and repointed, never silently authoritative
      if (parsed.spec.type !== "delegation") continue;
      // The three things a delegation cannot resolve without: who runs, where, and the standing brief.
      expect(parsed.spec.harness.id).toBeTruthy();
      expect(parsed.spec.image).toBeTruthy();
      expect(parsed.spec.instructions).toContain("BRIEF.md"); // it must point the delegate at its own brief
      expect(parsed.spec.instructionsFile).toBeTruthy();
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

// The code loop composes delegation and the campaign; what the test pins is that every door it drives exists by
// name in the body, that the two disciplines it adds to harness_evolve are stated (the oracle's PATHS as a
// constraint the driver checks against the PR, and the CI-built digest pinned into a REAL candidate version
// because a PR-mode scorecard names the base version), and that its brief reference travels with it.
describe("the code-evolve example composes delegation into the campaign", () => {
  const skill = firstPartySkillExamples().find((r) => r.id === "code-evolve");

  it("names every door it drives and the two disciplines that make a delegated change a candidate", () => {
    expect(skill).toBeDefined();
    if (!skill || skill.spec.type !== "skill") return;
    for (const anchor of [
      "create_sandbox",
      "submit_sandbox_task",
      "sandbox_git_push",
      "pin_harness_images",
      "run_scorecard",
      "log_campaign_round",
      "campaign_decision",
      "adopt_campaign_candidate",
      "merge_campaign_candidate",
      "oracle",
      "changed files",
      "Do NOT merge",
      "references/round-brief.md",
    ]) {
      expect(skill.spec.instructions).toContain(anchor);
    }
    const brief = skill.spec.files.find((f) => f.path === "references/round-brief.md");
    expect(brief).toBeDefined();
    for (const anchor of ["goal", "constraints", "doneWhen", "oracle", "DIGEST"]) {
      expect(brief?.content).toContain(anchor);
    }
  });
});
