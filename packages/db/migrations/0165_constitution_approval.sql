-- 0165_constitution_approval — additive (expand): the RECEIPT for a constitutional declaration.
--
-- A dataset whose graders declare `ground_truth` redefines what passing means for every evaluation that ever
-- runs it. Registering one now requires the admin role (arch-review 22 P0-2) — but authorization at the door
-- leaves no trace, so a dataset already in the database is indistinguishable between:
--
--   an admin approved it   ·   a member registered it before the gate existed   ·   it is a platform seed
--
-- The receipt is that trace. Kept BESIDE the artifact, never inside it: an approval is provenance, and
-- provenance inside a versioned spec would change the content digest of the thing being approved.
--
-- `mode` distinguishes the three, because "approved" and "nobody ever checked" must not read alike:
--   approved         — an admin authorized this exact content at registration
--   platform_seed    — a first-party `_shared` document, authorized by shipping it
--   legacy_attested  — an admin has since attested a pre-gate document, naming what they were attesting to
CREATE TABLE IF NOT EXISTS everdict_constitution_approval (
  tenant        text NOT NULL,
  kind          text NOT NULL, -- dataset (the only declaring artifact today)
  id            text NOT NULL,
  version       text NOT NULL,
  content_digest text NOT NULL, -- WHICH bytes were approved — a re-registration of different content is not this one
  metrics       jsonb NOT NULL, -- the declarations that needed approving, so a reader sees what was granted
  mode          text NOT NULL,
  approved_by   text,
  approved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, kind, id, version)
);
