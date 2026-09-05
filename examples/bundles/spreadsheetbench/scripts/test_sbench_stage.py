#!/usr/bin/env python3
"""The pairing decision's counterexamples. Standard library only — run it with `python3 <this file>`.

Every case below is a shape this checker got WRONG at some point in two days, and each was found by a person
running the staging script against the real 912-instruction dataset. That is the whole reason this file
exists: the decision was reachable only through three workbooks on disk and openpyxl, so the only available
test was a full stage, and the only available reviewer was whoever ran it.

`scripts/check-python.mjs` runs this on every push. Before it, nothing in this repository's gates could see a
`.py` file at all — no linter, no type checker, no test runner reached `examples/bundles/**`, while the file
that decides WHAT THE EXAM IS was fixed five times.
"""
import sys, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from sbench_pairing import classify_pairing

FAILURES = []


def check(name, got, want):
    if got != want:
        FAILURES.append(f"{name}\n      expected {want!r}\n      got      {got!r}")


# A workbook's context is a dict of (sheet, cell) -> canonical value. Distinct letters = discriminating bytes.
def ctx(*vals):
    return {("Sheet1", f"A{i}"): v for i, v in enumerate(vals, start=1)}


EMPTY = {}

# ── the ordinary shape: every answer pairs with its own input ────────────────────────────────────────
kind, detail, checked = classify_pairing(
    {1: ctx("a"), 2: ctx("b"), 3: ctx("c")},
    {1: ctx("a"), 2: ctx("b"), 3: ctx("c")},
)
check("a key that pairs with its own input is admitted", (kind, detail, checked), ("admitted", "", 3))

# ── case 15380: answers 2 and 3 swapped. No task effect produces a permutation. ──────────────────────
kind, detail, checked = classify_pairing(
    {1: ctx("a"), 2: ctx("b"), 3: ctx("c")},
    {1: ctx("a"), 2: ctx("c"), 3: ctx("b")},
)
check("a swapped answer key is refused", (kind, checked), ("refused", 3))
check("…and the refusal names the swap", "answer 2 is input 3's" in detail, True)

# ── THE IDENTITY IS ASKED FIRST. Two inputs with equal contexts admit both the identity and a swap; ──
# reading the swap reported 70 correct keys as mispaired, all naming the same permutation.
kind, _, _ = classify_pairing(
    {1: ctx("a"), 2: ctx("same"), 3: ctx("same")},
    {1: ctx("a"), 2: ctx("same"), 3: ctx("same")},
)
check("two equal contexts do not make a correct key a swap", kind, "admitted")

# ── case 97-36: every value lives inside the answer range, so `{} == {}` proved nothing. ─────────────
kind, _, checked = classify_pairing(
    {1: ctx("a"), 2: ctx("b"), 3: ctx("c")},
    {1: EMPTY, 2: EMPTY, 3: EMPTY},
)
check("no discriminating bytes is a third value, not a verdict", (kind, checked), ("no_evidence", 0))

# ── THE FIX UNDER TEST: one result-only answer file used to discard the other two files' evidence. ───
# RED before it, whose `not all(answers[n] ...)` short-circuited the whole case:
#   ('no_evidence', 0) != ('refused', 2)
kind, detail, checked = classify_pairing(
    {1: ctx("a"), 2: ctx("b"), 3: ctx("c")},
    {1: ctx("b"), 2: ctx("a"), 3: EMPTY},
)
check("a swap is still found when only two files can answer", (kind, checked), ("refused", 2))
check("…and the refusal says how much it could see", "2 of 3" in detail, True)

# …and the same partial evidence must not INVENT a refusal when the identity holds over it.
kind, detail, checked = classify_pairing(
    {1: ctx("a"), 2: ctx("b"), 3: ctx("c")},
    {1: ctx("a"), 2: ctx("b"), 3: EMPTY},
)
check("partial evidence that pairs is admitted, not refused", (kind, checked), ("admitted", 2))
check("…and admission still declares what went unchecked", "file(s) 3 could not be checked" in detail, True)

# ── WHAT IT ONLY REPORTS: a task that sorts or fills legitimately changes cells outside the range. ───
kind, detail, checked = classify_pairing(
    {1: ctx("a"), 2: ctx("b"), 3: ctx("c")},
    {1: {**ctx("a"), ("Sheet1", "Z9"): "helper"}, 2: ctx("b"), 3: ctx("c")},
)
check("a helper cell is admitted with a report, never refused", (kind, checked), ("admitted_with_report", 3))
check("…and it is classified from the VALUES", "helper cells only" in detail, True)

# `changed` — both present and different — is the one worth a human (cases 17047, 30930).
kind, detail, _ = classify_pairing(
    {1: {**ctx("a"), ("Sheet1", "A31"): -3039}, 2: ctx("b"), 3: ctx("c")},
    {1: {**ctx("a"), ("Sheet1", "A31"): -30}, 2: ctx("b"), 3: ctx("c")},
)
check("source data differing is the finding a human reads", "SOURCE DATA DIFFERS" in detail, True)

if FAILURES:
    print(f"\n✖ sbench pairing: {len(FAILURES)} counterexample(s) failed\n", file=sys.stderr)
    for f in FAILURES:
        print(f"  - {f}\n", file=sys.stderr)
    sys.exit(1)
print("PASS sbench pairing: 11 counterexamples over the staging decision.")
