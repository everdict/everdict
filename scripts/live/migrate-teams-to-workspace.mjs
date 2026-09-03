// Move everything a TEAM owned to the WORKSPACE, and re-issue every issue identifier under one prefix.
//
// The team was seven things at once (docs/tracker.md), and only one of them — ownership — is a pure rename to
// the workspace. The other six leave residue that a schema migration cannot decide about, which is why this is
// a script an operator runs and reads rather than a `0212` that runs itself:
//
//   ① OWNERSHIP is a no-op in data terms. `tenant` already says which workspace a row belongs to, so dropping
//      `team_id` loses no addressing — but it does merge what were separate lists, and the counts say by how
//      much.
//   ② IDENTIFIERS are RE-ISSUED. `ENG-12` is a public address; the maintainer chose one workspace prefix over
//      freezing the old ones, so every issue is renumbered in `created_at` order under `<KEY>-<n>`. The old
//      name is appended to `former_identifiers` — the field a team move already used — so the history still
//      says what an issue used to be called even though the address stops resolving.
//   ③ PRIVACY is LOST, and this script's most important output is the number attached to that. Assets of a
//      private team become visible to every member of the workspace the moment `0212` drops `is_private`.
//      That is irreversible and it is counted BEFORE anything is written, so an operator can answer "how many
//      things is this about to expose" beforehand rather than afterwards.
//
// The shape of it:
//   * NOTHING IS DESTROYED HERE. This script only WRITES the workspace key, the counter and the new
//     identifiers. Dropping the team columns and tables is `0212`, a separate deliberate step — so a run that
//     goes wrong leaves a database that the previous release still reads.
//   * IT REPORTS BEFORE IT WRITES. `--dry-run` prints every number below and changes nothing; that is the
//     intended first invocation.
//   * ONE TRANSACTION PER WORKSPACE. A half-renumbered workspace would have two prefixes live at once and a
//     counter that agrees with neither, so each workspace commits or does not.
//   * IDEMPOTENT. A workspace that already has an `issue_key` and whose issues all carry that prefix is
//     skipped, so a re-run after a crash finishes the job instead of renumbering twice.
//
// Usage:
//   DATABASE_URL=postgresql://USER:PASS@HOST:5432/db node scripts/live/migrate-teams-to-workspace.mjs
//   … --dry-run              report only — the intended first run
//   … --key EVD              force the prefix for EVERY workspace (default: derived per workspace, see below)
//   … --workspace acme       one workspace only
//   … --yes                  skip the "this exposes N private assets" confirmation prompt

import { createInterface } from "node:readline/promises";
// ⚠️ RELATIVE `dist` PATHS, not package names. `scripts/` is not a workspace package, so pnpm links no
// `node_modules/@everdict/*` for it and a bare specifier throws ERR_MODULE_NOT_FOUND — on the operator's
// machine, on the one run that matters. Every other script in this directory imports the same way.
import { deriveIssueKey } from "../../packages/contracts/dist/index.js";
import { makePool, sqlClient } from "../../packages/db/dist/index.js";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = has("dry-run");
const FORCED_KEY = val("key");
const ONLY = val("workspace");
const ASSUME_YES = has("yes");

if (FORCED_KEY !== undefined && !/^[A-Z][A-Z0-9]{1,5}$/.test(FORCED_KEY)) {
  console.error(`--key "${FORCED_KEY}" is not 2–6 uppercase characters starting with a letter.`);
  process.exit(1);
}

// The tables migration 0106 and its successors gave a `team_id`. Listed here so the report says what it is
// about to merge rather than making the reader open the migrations.
const OWNED = [
  "everdict_harness_templates",
  "everdict_harness_instances",
  "everdict_datasets",
  "everdict_judges",
  "everdict_rubrics",
  "everdict_runtimes",
  "everdict_models",
  "everdict_agents",
  "everdict_benchmarks",
  "everdict_scorecards",
  "everdict_runs",
  "everdict_environments",
  "everdict_evolution_campaigns",
];

const pool = makePool(URL_, { applicationName: "everdict-team-migration", statementTimeoutMs: 600_000 });
const db = sqlClient(pool);

const exists = async (table) => {
  const { rows } = await db.query("SELECT to_regclass($1) AS t", [table]);
  return rows[0]?.t !== null && rows[0]?.t !== undefined;
};

// A prefix from the workspace's own name: the first letters of its id, uppercased, 2–6 characters. Derived
// rather than defaulted in SQL because a workspace called `acme-platform-eu` has no obvious short name — and
// an operator who dislikes the guess passes `--key`.
async function main() {
  if (!(await exists("everdict_teams"))) {
    console.log("✓ no everdict_teams table — this database has already contracted past the team axis.");
    return;
  }

  // ── WHAT THIS IS ABOUT TO EXPOSE ────────────────────────────────────────────────────────────────
  //
  // Counted first and printed whatever the mode, because it is the one consequence nobody can undo. A private
  // team's assets are readable only by its members today; after `0212` they are readable by the workspace.
  const { rows: privateTeams } = await db.query(
    `SELECT t.id, t.key, t.name, t.tenant FROM everdict_teams t WHERE t.is_private ${ONLY ? "AND t.tenant = $1" : ""}`,
    ONLY ? [ONLY] : [],
  );
  let exposed = 0;
  for (const table of OWNED) {
    if (!(await exists(table))) continue;
    for (const team of privateTeams) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant = $1 AND team_id = $2`, [
        team.tenant,
        team.id,
      ]);
      exposed += rows[0]?.n ?? 0;
    }
  }
  const { rows: privateIssues } = privateTeams.length
    ? await db.query("SELECT count(*)::int AS n FROM everdict_issues WHERE team_id = ANY($1::text[])", [
        privateTeams.map((t) => t.id),
      ])
    : { rows: [{ n: 0 }] };

  console.log("── privacy ─────────────────────────────────────────────────────────────────");
  if (privateTeams.length === 0) {
    console.log("  no private teams — nothing becomes newly visible.");
  } else {
    console.log(
      `  ${privateTeams.length} private team(s): ${privateTeams.map((t) => `${t.key} (${t.tenant})`).join(", ")}`,
    );
    console.log(`  ${exposed} eval asset/result row(s) and ${privateIssues[0]?.n ?? 0} issue(s) become visible`);
    console.log("  to every member of their workspace once 0212 drops is_private. This cannot be undone.");
  }

  const { rows: workspaces } = await db.query(
    `SELECT w.id, w.issue_key, w.issue_counter FROM everdict_workspaces w
      ${ONLY ? "WHERE w.id = $1" : ""} ORDER BY w.id`,
    ONLY ? [ONLY] : [],
  );

  console.log("\n── per workspace ───────────────────────────────────────────────────────────");
  const plans = [];
  for (const ws of workspaces) {
    const { rows: teams } = await db.query("SELECT count(*)::int AS n FROM everdict_teams WHERE tenant = $1", [ws.id]);
    const { rows: issues } = await db.query("SELECT count(*)::int AS n FROM everdict_issues WHERE tenant = $1", [
      ws.id,
    ]);
    const key = FORCED_KEY ?? ws.issue_key ?? deriveIssueKey(ws.id);
    // Already done: the key is set and every identifier already carries it.
    const { rows: stale } = await db.query(
      "SELECT count(*)::int AS n FROM everdict_issues WHERE tenant = $1 AND identifier NOT LIKE $2",
      [ws.id, `${key}-%`],
    );
    const done = ws.issue_key === key && (stale[0]?.n ?? 0) === 0;
    plans.push({ ws, key, teams: teams[0]?.n ?? 0, issues: issues[0]?.n ?? 0, restamp: stale[0]?.n ?? 0, done });
    console.log(
      `  ${ws.id.padEnd(24)} key=${key.padEnd(6)} teams=${String(teams[0]?.n ?? 0).padStart(3)} issues=${String(issues[0]?.n ?? 0).padStart(5)} re-issue=${String(stale[0]?.n ?? 0).padStart(5)}${done ? "   (already migrated)" : ""}`,
    );
  }

  if (DRY) {
    console.log("\n▶ dry run — nothing was changed. Re-run without --dry-run to apply.");
    return;
  }
  if (exposed > 0 && !ASSUME_YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nProceed, exposing ${exposed} previously team-private row(s)? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("aborted — nothing was changed.");
      return;
    }
  }

  console.log("");
  for (const plan of plans) {
    if (plan.done) {
      console.log(`✓ ${plan.ws.id}: already migrated`);
      continue;
    }
    // ONE TRANSACTION PER WORKSPACE. A half-renumbered workspace has two prefixes live and a counter that
    // agrees with neither — there is no readable intermediate state to leave behind.
    await db.transaction(async (tx) => {
      // Re-issue in `created_at` order so the sequence reads like the history it names: the oldest issue is
      // number 1, whatever team minted it. Ties broken by id so a re-run is deterministic.
      const { rows: ordered } = await tx.query(
        "SELECT id, identifier, former_identifiers FROM everdict_issues WHERE tenant = $1 ORDER BY created_at, id",
        [plan.ws.id],
      );
      // ── TWO PASSES, BECAUSE A RENAME WALKS INTO NAMES ITS OWN SIBLINGS STILL HOLD ──────────────
      //
      // `0211` puts a unique index on `(tenant, identifier)`, which is what makes `GET /issues/EVD-12` a
      // lookup. A single-pass rename hits it: a workspace `acme` whose team key was already `ACME` derives the
      // prefix `ACME`, so re-issuing in `created_at` order assigns `ACME-1` to an older issue while the row
      // that currently holds `ACME-1` has not been renamed yet. Postgres refuses, the transaction rolls back,
      // and the operator cannot migrate at all. That is not a rare shape — it is what a single-team workspace
      // named after its team looks like.
      //
      // `identifier` is NOT NULL, so the rows cannot be parked at NULL. They are parked under a name no key
      // can mint instead: `ISSUE_KEY_PATTERN` is `^[A-Z][A-Z0-9]{1,5}$` and an identifier is `<key>-<digits>`,
      // so nothing with a `~` or a lowercase stem is reachable by any real prefix. Both passes are inside the
      // workspace's own transaction, so a failure in either leaves the identifiers exactly as they were.
      const plan_ = ordered.map((issue, i) => ({ issue, n: i + 1, next: `${plan.key}-${i + 1}` }));
      const moving = plan_.filter((p) => p.issue.identifier !== p.next);
      for (const { issue, n } of moving) {
        await tx.query("UPDATE everdict_issues SET identifier = $1 WHERE tenant = $2 AND id = $3", [
          `reissue~${n}`,
          plan.ws.id,
          issue.id,
        ]);
      }
      for (const { issue, n, next } of moving) {
        // The old name is remembered, not discarded — `former_identifiers` is the field the history reads, so
        // an issue can still be found by what it used to be called.
        const former = Array.isArray(issue.former_identifiers) ? issue.former_identifiers : [];
        const kept = [...new Set([...former, issue.identifier].filter((v) => typeof v === "string" && v !== ""))];
        await tx.query(
          "UPDATE everdict_issues SET number = $1, identifier = $2, former_identifiers = $3::jsonb WHERE tenant = $4 AND id = $5",
          [n, next, JSON.stringify(kept), plan.ws.id, issue.id],
        );
      }
      // A row already sitting on its final name still needs its NUMBER to agree with it.
      for (const { issue, n } of plan_.filter((p) => p.issue.identifier === p.next)) {
        await tx.query("UPDATE everdict_issues SET number = $1 WHERE tenant = $2 AND id = $3", [
          n,
          plan.ws.id,
          issue.id,
        ]);
      }
      const n = plan_.length;
      // The counter lands past the last number minted, so the next file cannot collide with a name that now
      // exists. Written in the same transaction as the identifiers it must agree with.
      await tx.query("UPDATE everdict_workspaces SET issue_key = $1, issue_counter = $2 WHERE id = $3", [
        plan.key,
        n,
        plan.ws.id,
      ]);
    });
    console.log(`✓ ${plan.ws.id}: ${plan.issues} issue(s) re-issued under ${plan.key}, counter at ${plan.issues}`);
  }

  console.log("\ndone. The team columns are still in place — apply migration 0212 to drop them.");
}

try {
  await main();
} catch (err) {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
