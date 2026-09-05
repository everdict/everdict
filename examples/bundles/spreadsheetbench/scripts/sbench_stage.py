#!/usr/bin/env python3
"""Mint a SpreadsheetBench task set — and REFUSE the cases no correct agent could have passed.

`sbench_digest.py` holds a salted digest of the answer so the oracle need not ride into the agent's
container. Whoever mints those digests decides what the exam IS, and a digest minted from a broken answer
key is an exam that scores a correct answer zero. Nothing downstream can tell that apart from an agent that
got it wrong: the reward file says 0.0 either way, the round is comparable, the campaign's gate derives a
verdict, and the whole loop optimizes inside a measurement that was never winnable.

So the mint and the check have ONE owner, and it is this file. It imports `parse_answer_position` and
`digest_of` from `sbench_digest` rather than restating them — a predicate written twice has already
diverged (rule `protocol`, L3).

WHAT IT REFUSES, and why each one is PROVABLE rather than suspected:

  · an `answer_position` this grader cannot read. 420 of the published 912 are sheet-qualified or
    multi-range; before `parse_answer_position` existed they raised inside the per-file read and were
    recorded as "output could not be read" — an ordinary 0.0. A question the grader cannot ask may not
    be answered (rule `protocol`, L2).
  · fewer than four answer cells. `sbench_digest.py`'s docstring already states this bound — a digest over
    one small number is guessable — and until now nothing enforced it.
  · a MISPAIRED answer key: comparing the cells OUTSIDE the answer range, no answer workbook pairs with its
    OWN input, and a bijection onto the other inputs does. Every answer matched to exactly one input and
    every input claimed once is a permutation; no task effect produces one. Case 15380 is one — answers 2
    and 3 are swapped — so an agent that solves all three workbooks correctly is scored 1/3 and fails.
    Measured, on the real data, with a real agent's real output.

    THE IDENTITY IS ASKED FIRST, and that ordering is the whole check. Two test cases commonly differ only
    INSIDE the answer range, which makes their contexts equal — and then the identity and a swap of those
    two are both bijections. Looking for a non-identity permutation and taking the first hit reported 70
    correct keys as mispaired, all naming the same swap, which is what gave it away.

WHAT IT CANNOT CHECK, and says so. Not every answer workbook is "the input with the answer written into
it": for an extraction task it is a result-only sheet with nothing outside `answer_position` at all. There
is then no evidence either way, and the honest answer is a third value rather than a verdict. The first
version of this file did not have it, compared `{}` to `{}`, and refused 10 cases on an empty match — case
97-36 has all 22 of its values inside `A1:A22`, so every answer file matched whichever input also happened
to have nothing outside. Those cases are staged and counted separately.

WHAT IT ONLY REPORTS. An answer workbook whose non-answer cells match NO input is not proof of anything: a
task that sorts a table or fills a column legitimately changes cells outside `answer_position`. Cases 17047
and 30930 are in this bucket and look like data slips on inspection (one literal in a column the
instruction never writes — `A31` is -3039 in the input and -30 in the answer), but "looks like" is not a
refusal. They are printed with the differing cells so a human can decide, and they are still minted.
"""
import argparse, hashlib, json, pathlib, sys
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter, range_boundaries

from sbench_digest import canon, digest_of
from sbench_pairing import classify_pairing
from sbench_position import cell_count, parse_answer_position

MIN_ANSWER_CELLS = 4


def context(path, positions, fallback_sheet):
    """Every non-empty cell OUTSIDE the answer range, canonicalized the way the grader canonicalizes.

    The grader's own `canon` is reused so this comparison rounds floats exactly as scoring does — without
    that, `0.0009995002498750624` and `0.000999500249875062` read as a difference and every case with a
    computed column looks mispaired.
    """
    # `read_only=True` streams rows instead of building the whole object graph. A full 912-instruction stage
    # opens 5,472 workbooks, some with sheets of 5,000+ rows, and took ~50 minutes without it.
    wb = load_workbook(path, data_only=True, read_only=True)
    covered = set()
    for part_sheet, rng in positions:
        name = part_sheet or fallback_sheet
        ws = wb[name] if (name and name in wb.sheetnames) else wb.active
        c1, r1, c2, r2 = range_boundaries(rng)
        covered |= {(ws.title, r, c) for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)}
    out = {}
    for ws in wb.worksheets:
        # A read-only sheet yields `EmptyCell` for gaps, which carries no coordinate at all — so the row and
        # column are tracked here rather than read off the cell. Enumerating gives the same answer for a
        # normal cell and is the only answer available for an empty one.
        for r, row in enumerate(ws.iter_rows(), start=1):
            for c, cell in enumerate(row, start=1):
                if cell.value is None or (ws.title, r, c) in covered:
                    continue
                key = canon(cell)
                if key != "S":  # an empty string is an absent value, not a difference
                    out[(ws.title, f"{get_column_letter(c)}{r}")] = key
    return out


def examine(root, task, salt):
    """-> (kind, detail, digests, checked).

    kind is 'admitted' (the key pairs with its input), 'refused' (provably unwinnable), 'no_evidence' (the
    answer workbooks carry nothing the pairing could be checked against) or 'admitted_with_report' (they
    differ, which a task legitimately can cause). The last two are staged; only 'refused' is dropped.

    `checked` is how many of the three answer workbooks carried discriminating bytes — 0..3. It rides out of
    here and into `tasks.json` because it is the difference between a key that was verified and one nothing
    could verify, and a downstream reader that cannot tell those apart is being handed a claim.
    """
    cid = str(task["id"])
    directory = root / cid
    try:
        positions = parse_answer_position(task["answer_position"])
    except Exception as exc:
        return "refused", f"answer_position {task['answer_position']!r} is unreadable ({exc})", None, 0
    cells = cell_count(positions)
    if cells < MIN_ANSWER_CELLS:
        # NOT "this case is broken" — it is fine, and this CHECKER cannot hold its answer safely. The
        # distinction is the whole point of an actionable refusal: 164 of the published 912 land here, and
        # telling an operator "guessable" without telling them what would work reads as "18% of this
        # benchmark is unusable" when it means "18% of it needs the other lane".
        return (
            "refused",
            f"{cells} answer cell(s): a salted digest over so few values is guessable by the agent, which "
            f"shares this container with the checker. The case is fine — score it on a lane with a private "
            f"verifier (the Nomad and K8s backends implement dispatchVerifier), where the answer never enters "
            f"the agent's world at all",
            None,
            0,
        )

    sheet = task.get("answer_sheet") or ""
    try:
        inputs = {n: context(directory / f"{n}_{cid}_input.xlsx", positions, sheet) for n in (1, 2, 3)}
        answers = {n: context(directory / f"{n}_{cid}_answer.xlsx", positions, sheet) for n in (1, 2, 3)}
    except Exception as exc:
        return "refused", f"a workbook could not be read ({type(exc).__name__}: {exc})", None, 0

    def digests_for():
        return [digest_of(directory / f"{n}_{cid}_answer.xlsx", sheet, positions, salt) for n in (1, 2, 3)]

    kind, detail, checked = classify_pairing(inputs, answers)
    return kind, detail, (None if kind == "refused" else digests_for()), checked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="the unpacked all_data_912 directory")
    ap.add_argument("--out", required=True, help="where to write tasks.json")
    ap.add_argument("--ids", default="", help="comma-separated instruction ids; default is every one")
    args = ap.parse_args()

    root = pathlib.Path(args.data)
    dataset = json.loads((root / "dataset.json").read_text())
    if args.ids:
        wanted = {i.strip() for i in args.ids.split(",") if i.strip()}
        dataset = [t for t in dataset if str(t["id"]) in wanted]
        missing = wanted - {str(t["id"]) for t in dataset}
        if missing:
            print(f"no such instruction: {', '.join(sorted(missing))}", file=sys.stderr)
            return 2

    staged, refused, reported, unchecked, partial = [], [], [], [], []
    for task in dataset:
        cid = str(task["id"])
        salt = hashlib.sha256(f"{cid}|everdict-spreadsheetbench".encode()).hexdigest()[:16]
        kind, detail, digests, checked = examine(root / "spreadsheet", task, salt)
        if kind == "refused":
            refused.append((cid, detail))
            continue
        if kind == "admitted_with_report":
            reported.append((cid, detail))
        if checked == 0:
            unchecked.append(cid)
        elif checked < 3:
            partial.append((cid, checked))
        staged.append({
            "id": task["id"],
            "instruction": task["instruction"],
            "answer_position": task["answer_position"],
            "answer_sheet": task.get("answer_sheet", ""),
            "salt": salt,
            "digests": digests,
            # ── WHAT THIS KEY WAS ACTUALLY CHECKED AGAINST, IN THE ARTIFACT ─────────────────────────
            #
            # The counts below go to a terminal, and a terminal is not a record. A staged case used to be
            # a staged case: a key verified against three paired workbooks and a key nothing could check
            # were the same six fields, so no reader downstream — the campaign, the wave driver, a person
            # opening tasks.json six months later — could tell them apart. That is the shape rule
            # `protocol` L3 is about: the decision existed and was left where nobody could consume it.
            #
            # `verdict` is this file's own kind, `checked` is how many of the three answer workbooks
            # carried discriminating bytes. `checked: 0` means the pairing was UNVERIFIABLE, not verified.
            "key_check": {"verdict": kind, "checked": checked, "of": 3},
        })

    pathlib.Path(args.out).write_text(json.dumps(staged, indent=2))
    print(f"staged {len(staged)} of {len(dataset)} instructions -> {args.out}")
    # ⚠️ NAMED, NOT COUNTED. `refused` and `reported` printed their ids from the start; this bucket printed
    # a number, so the one class of case where the exam is unverifiable was also the one class a person could
    # not go and look at. A count is a statistic about the run; an id is a case somebody can open.
    if unchecked:
        print(f"\n{len(unchecked)} could not have their answer key checked AT ALL — the answer workbooks hold "
              f"nothing outside the answer range, so there is no pairing evidence either way. Staged with "
              f"key_check.checked = 0:", file=sys.stderr)
        print(f"  {', '.join(unchecked)}", file=sys.stderr)
    if partial:
        print(f"\n{len(partial)} had their key checked against SOME of their workbooks — the rest are "
              f"result-only sheets with nothing outside the answer range:", file=sys.stderr)
        for cid, checked in partial:
            print(f"  {cid}: {checked} of 3", file=sys.stderr)
    if reported:
        print(f"\n{len(reported)} admitted with a pairing report (a human should read these):", file=sys.stderr)
        for cid, detail in reported:
            print(f"  {cid}: {detail}", file=sys.stderr)
    if refused:
        print(f"\n{len(refused)} REFUSED — unwinnable as published, so they are not an exam:", file=sys.stderr)
        for cid, detail in refused:
            print(f"  {cid}: {detail}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
