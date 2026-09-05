#!/usr/bin/env python3
"""The ONE reader of SpreadsheetBench's `answer_position` field.

Every scorer here has to answer the same question — which cells, on which sheets, is this task judged on —
and it was being answered twice, differently, by two files that both got it wrong:

    sbench_grade.py   a regex that assumed `'Sheet'!A1:B10`, so `Sheet1'!A1:M237` came back as a RANGE
                      named "Sheet1'!A1:M237" and blew up in `ws[a1]`
    sbench_digest.py  `range_boundaries(whole_string)`, which raises on anything but a plain range — and
                      the raise was caught by a per-file `except Exception` and recorded as an ordinary
                      wrong answer, so 420 of the 912 published tasks were unwinnable and scored 0.0

That is rule `protocol` L3 exactly: a predicate written twice has already diverged. So it lives here once,
and `sbench_digest`, `sbench_grade` and `sbench_stage` import it.

THE PUBLISHED FIELD IS NOT CONSISTENTLY QUOTED. All of these appear in `dataset.json` for the same intent:

    C2:C66          Sheet1'!A1:M237          'MINUS'!B2:E11,'PLUS'!B2:E5200
    'Vendor!'A1:D101,'NotPaid!'A1:D7         'Calculation!'C11:I490'

So the apostrophes are not parsed. `!` is: a sheet name may not contain one and neither may an A1 range,
which makes it the only reliable separator. Everything before it is the sheet, everything after is the
range, and quotes come off both. Commas separate parts, ignoring commas inside quotes.

AND A POSITION THAT CANNOT BE SCORED IS REFUSED HERE rather than further down. Three of the 912 are
unscoreable as published — an open-ended range (`A:G`, whose extent would come from whichever workbook is
being read, so two files with the same answer could disagree), a malformed reference (`BD2:308`) and a
full-width colon (`G12：J15`). Refusing them at parse time is what lets a caller distinguish "the agent got
it wrong" from "this grader cannot ask the question", which L2 says may never be spent as a verdict.
"""
from openpyxl.utils import range_boundaries


def split_parts(spec):
    """Comma-separated, ignoring commas inside quotes."""
    parts, buf, quoted = [], [], False
    for ch in spec:
        if ch == "'":
            quoted = not quoted
            buf.append(ch)
        elif ch == "," and not quoted:
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf).strip())
    return [p for p in parts if p]


def parse_answer_position(spec):
    """`answer_position` -> [(sheet | None, "A1:B2"), ...]. Raises on anything unscoreable."""
    out = []
    for part in split_parts(spec):
        sheet = None
        if "!" in part:
            name, _, rng = part.rpartition("!")
            sheet = name.strip().strip("'").strip() or None
            rng = rng.strip().strip("'").strip()
        else:
            rng = part.strip("'").strip()
        bounds = range_boundaries(rng)
        if any(b is None for b in bounds):
            raise ValueError(f"{rng} is open-ended, and its extent would come from the workbook")
        out.append((sheet, rng))
    if not out:
        raise ValueError("answer_position is empty")
    return out


def cell_count(positions):
    total = 0
    for _sheet, rng in positions:
        c1, r1, c2, r2 = range_boundaries(rng)
        total += (r2 - r1 + 1) * (c2 - c1 + 1)
    return total


# ── self-test ─────────────────────────────────────────────────────────────────────────────────────────
# `python3 sbench_position.py` runs it. NO CI GATE CAN: the workflow installs no Python and never enters
# `examples/`, so this is the author's check, not the tree's. Every case below is a real `answer_position`
# from the published `dataset.json`, and the four refusals are the only three the 912 contain plus one
# constructed for the empty input.
CASES = [
    ("C2:C66", [(None, "C2:C66")]),
    ("Sheet1'!A1:M237", [("Sheet1", "A1:M237")]),
    ("'MINUS'!B2:E11,'PLUS'!B2:E5200", [("MINUS", "B2:E11"), ("PLUS", "B2:E5200")]),
    ("'Vendor!'A1:D101,'NotPaid!'A1:D7,'Paid!'A1:D43'", [("Vendor", "A1:D101"), ("NotPaid", "A1:D7"), ("Paid", "A1:D43")]),
    ("'Calculation!'C11:I490'", [("Calculation", "C11:I490")]),
    ("'Sheet'!A1:B10,C3", [("Sheet", "A1:B10"), (None, "C3")]),
]
REFUSED = ["Sheet3'!A:G,'Sheet4'!A:G", "'Sheet1'!BD2:308", "G12：J15", ""]

if __name__ == "__main__":
    import sys

    failures = []
    for spec, want in CASES:
        try:
            got = parse_answer_position(spec)
        except Exception as exc:
            failures.append(f"{spec!r} was refused ({exc})")
            continue
        if got != want:
            failures.append(f"{spec!r} -> {got}, wanted {want}")
    for spec in REFUSED:
        try:
            parse_answer_position(spec)
            failures.append(f"{spec!r} was accepted, and it is not scoreable")
        except Exception:
            pass
    if failures:
        print("\n".join(failures), file=sys.stderr)
        sys.exit(1)
    print(f"sbench_position: {len(CASES)} published shapes read, {len(REFUSED)} unscoreable refused")
