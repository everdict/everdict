#!/usr/bin/env python3
"""Score a SpreadsheetBench V1 task against a SALTED DIGEST of its answer instead of the answer workbook.

The official comparison is unchanged — cached cell values at `answer_position`, 2-dp rounding, exact type, and
all three test cases must pass. What changes is what the checker HOLDS: a sha256 of the canonicalized answer
under a per-task salt, not the answer itself.

WHY: an agent and its grader share one container on every runtime that has no separate verifier lane (only the
Nomad and K8s backends implement `dispatchVerifier`). Shipping the answer workbooks into that container would
put the oracle inside the thing being measured. A digest cannot be read back into values for a range of more
than a couple of cells, so the environment can carry the check without carrying the answer.

Its limit, stated: a digest over ONE small number is guessable, so tasks are selected with at least four
answer cells. This is a substitute for a private verifier, not a replacement for one.
"""
import argparse, hashlib, sys
from openpyxl import load_workbook
from openpyxl.utils import range_boundaries


def canon(cell):
    v = cell.value
    if v is None:
        return "N"
    if isinstance(v, bool):
        return f"B{v}"
    if isinstance(v, (int, float)):
        return f"F{round(float(v), 2):.2f}"
    return "S" + str(v).strip()


def digest_of(path, sheet, rng, salt):
    wb = load_workbook(path, data_only=True)
    ws = wb[sheet] if (sheet and sheet in wb.sheetnames) else wb.active
    lo_c, lo_r, hi_c, hi_r = range_boundaries(rng)
    parts = [canon(ws.cell(row=r, column=c)) for r in range(lo_r, hi_r + 1) for c in range(lo_c, hi_c + 1)]
    return hashlib.sha256((salt + "|" + "\x1f".join(parts)).encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--range", required=True)
    ap.add_argument("--sheet", default="")
    ap.add_argument("--salt", required=True)
    ap.add_argument("--digests", required=True, help="comma-separated, one per test case")
    args = ap.parse_args()

    want = args.digests.split(",")
    failed = []
    for n, expected in enumerate(want, start=1):
        out = f"{n}_{args.id}_output.xlsx"
        try:
            got = digest_of(out, args.sheet, args.range, args.salt)
        except FileNotFoundError:
            failed.append(f"test {n}: {out} was not produced")
            continue
        except Exception as exc:  # a workbook that cannot be read is a failed test case, not a crashed grader
            failed.append(f"test {n}: {out} could not be read ({type(exc).__name__})")
            continue
        if got != expected:
            failed.append(f"test {n}: {args.sheet or 'active'}!{args.range} does not match")
    if failed:
        print("\n".join(failed), file=sys.stderr)
        print(f"FAIL {len(failed)}/{len(want)} test case(s)", file=sys.stderr)
        return 1
    print(f"PASS all {len(want)} test cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
