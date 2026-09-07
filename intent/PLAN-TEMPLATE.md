# Plan: <title>

From: intent.md @ <sha of the commit that introduced the intent>

<!--
Committed BEFORE the implementation, not alongside it. The whole value of a plan is that changing course is
still a matter of editing a document. `pnpm intent-chain` refuses a plan whose intent is not older than it.
-->

## Files that change

Name them. A reader who has never seen the session should be able to implement from this alone.

## Order of work

Numbered. Each step is something that can be finished and verified.

## Risks

What this could break, and which step is the riskiest.

## Proof

What proves it works — the tests, the gate, the command whose output goes in the commit.
