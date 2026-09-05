#!/usr/bin/env python3
"""The pairing DECISION — does this answer key belong to this input? — and nothing else.

`sbench_position.py` exists because `answer_position` was being parsed twice, differently, by two files that
both got it wrong. This file exists for the sibling reason one level up: the pairing verdict was written
INSIDE the staging script's I/O, so reaching it needed three workbooks on disk and openpyxl, and nothing in
this repository's gates can see a `.py` file at all. `sbench_stage.py` was fixed five times in two days —
each fix finding the previous one's defect, every one of them found by a person running it against the real
912-instruction dataset, because there was no other way to run it.

So the decision lives here: dicts in, a verdict out, no imports beyond the standard library. `sbench_stage`
imports it, and `test_sbench_stage.py` drives it under bare `python3` — which is what
`scripts/check-python.mjs` runs on every push.

`inputs` and `answers` map 1|2|3 to that workbook's non-answer CONTEXT — the dict `sbench_stage.context()`
builds: every non-empty cell outside the answer range, canonicalized the way the grader canonicalizes. An
EMPTY dict means the workbook has nothing outside the answer range, and that case is the reason half the
comments below exist.
"""
import itertools


def classify_pairing(inputs, answers):
    """(inputs, answers) -> (kind, detail, checked). The pairing DECISION, and nothing else.

    Lifted out of `examine` so it can be driven without openpyxl and without a workbook on disk: dicts in, a
    verdict out. That is not a tidying — it is what makes the decision TESTABLE, and this file had been fixed
    five times in two days with no test able to reach it, because not one of this repository's gates
    could see a `.py` file at all. `scripts/check-python.mjs` runs `test_sbench_stage.py` against this
    function on every push; both exist because of the five fixes, not before them.

    `inputs` and `answers` map 1|2|3 to that workbook's non-answer context — the dict `context()` builds.
    An EMPTY dict means "this workbook has nothing outside the answer range", which is the case that started
    all of it.
    """
    # AN EMPTY CONTEXT MATCHES AN EMPTY CONTEXT, AND THAT IS NOT EVIDENCE OF ANYTHING. Not every answer
    # workbook is "the input with the answer filled in": for an extraction task it is a result-only sheet,
    # so everything outside `answer_position` is absent from it. Case 97-36 is that shape — all 22 of its
    # values live inside `A1:A22`, every answer file has nothing outside it, and `{} == {}` reported the
    # key as mispaired against whichever input also happened to have nothing outside. The first version of
    # this check refused 11 cases and 10 of them were this. So a pairing claim needs discriminating bytes.
    #
    # ⚠️ AND IT IS PER FILE, NOT PER CASE. The repair for the above asked `not all(answers[n] ...)`, which
    # throws away a whole case the moment ONE of its three answer workbooks is result-only — including the
    # evidence the other two were carrying. Case 15380's swap was found by exactly this comparison, so a
    # case with two rich answer files and one trimmed one is a mispairing this check would have declined to
    # look for. The question is asked over the files that can answer it, and how many those were is recorded.
    evident = [n for n in (1, 2, 3) if answers[n]]
    if not evident:
        return "no_evidence", "the answer workbooks hold nothing outside the answer range", 0

    partial = "" if len(evident) == 3 else (
        f" [only {len(evident)} of 3 answer workbooks carry anything outside the answer range; "
        f"file(s) {', '.join(str(n) for n in (1, 2, 3) if n not in evident)} could not be checked]"
    )
    matches = {n: [m for m in (1, 2, 3) if answers[n] == inputs[m]] for n in evident}

    # THE IDENTITY IS ASKED FIRST, AND IT ANSWERS THE QUESTION. Two test cases often differ only inside the
    # answer range, which makes their contexts equal — and then the identity AND a swap of those two are
    # both bijections. Searching for a non-identity permutation and taking the first hit reported 70 cases
    # as "answer 2 is input 3's, answer 3 is input 2's" whose keys were perfectly correct; the giveaway was
    # that all 70 named the same permutation. A key that pairs with its own input is paired, however many
    # other readings the data also admits.
    if all(n in matches[n] for n in evident):
        return "admitted", partial.strip(), len(evident)

    # Only now is a bijection evidence: every answer with discriminating bytes matched to exactly one input,
    # every input claimed at most once, and the identity unavailable. `permutations(_, k)` is injective by
    # construction, so a k-file answer is held to the same standard the three-file one was — a permutation,
    # and no task effect produces one.
    #
    # ⚠️ TWO FILES AT MINIMUM, AND THAT BOUND IS THE WHOLE ARGUMENT. With ONE evident answer file there is no
    # bijection to find — "answer 1's context equals input 2's" is a single coincidence, and reading a single
    # coincidence as a swap is precisely the mistake that refused 70 correct keys before the identity was
    # asked first. A refusal drops a case from the exam and says nothing downstream, so the file with one
    # readable answer is REPORTED, not refused: a human decides on evidence, which is what the report is for.
    permutation = (
        next(
            (p for p in itertools.permutations((1, 2, 3), len(evident))
             if p != tuple(evident) and all(answers[n] == inputs[p[i]] for i, n in enumerate(evident))),
            None,
        )
        if len(evident) >= 2
        else None
    )
    if permutation is not None:
        pairs = ", ".join(f"answer {n} is input {permutation[i]}'s" for i, n in enumerate(evident)
                          if permutation[i] != n)
        return "refused", f"the answer key is mispaired ({pairs}){partial}", len(evident)

    drifted = [n for n in evident if n not in matches[n]]
    if drifted:
        # ── CLASSIFIED, NOT DUMPED ──────────────────────────────────────────────────────────────────
        #
        # 220 of the 912 land here and "a human should read these" is not a finding, it is 220 findings
        # nobody will read. The difference splits three ways and only one of them is worth a human:
        #
        #   added    the answer has a value where the input had none — a helper cell the solution wrote,
        #            which is what most tasks do. Ordinary.
        #   removed  the input had a value the answer does not — the solution cleared it, or the answer
        #            workbook is a trimmed result sheet. Ordinary.
        #   changed  BOTH present and different: the answer's source data is not the input's. Nothing a
        #            task does to a cell outside `answer_position` produces this, and it is the shape of
        #            17047 (`A31` is -3039 in the input, -30 in the answer) and 30930 (`A6` is 0, then
        #            15.44), whose instructions never write those columns.
        #
        # Classified from the VALUES, never from the rendered line — parsing this file's own output back
        # into a decision is the re-derivation rule `protocol` L3 forbids.
        kinds = {"added": 0, "removed": 0, "changed": 0}
        detail = []
        for n in drifted:
            diff = sorted(k for k in set(answers[n]) | set(inputs[n]) if answers[n].get(k) != inputs[n].get(k))
            for key in diff:
                before, after = inputs[n].get(key), answers[n].get(key)
                kinds["added" if before is None else "removed" if after is None else "changed"] += 1
            shown = ", ".join(
                f"{sheet}!{cell}: input={inputs[n].get((sheet, cell))} answer={answers[n].get((sheet, cell))}"
                for sheet, cell in diff[:4]
            )
            detail.append(f"file {n} differs outside the answer range at {len(diff)} cell(s) — {shown}")
        summary = " ".join(f"{k}={v}" for k, v in kinds.items() if v > 0)
        head = "SOURCE DATA DIFFERS" if kinds["changed"] > 0 else "helper cells only"
        return "admitted_with_report", f"[{head}: {summary}] " + "; ".join(detail) + partial, len(evident)
    return "admitted", partial.strip(), len(evident)
