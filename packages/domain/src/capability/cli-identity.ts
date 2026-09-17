import { BadRequestError, type CliIdentitySpec, ConflictError } from "@everdict/contracts";

// The rules a registered CLI identity is held to, and the rule for choosing WHICH one a session runs as.
// Pure: the store fetches, the service composes, nothing here reads or writes.
//
// Why the choice is a rule rather than a lookup: an identity is a credential, so "which one" is a question
// about WHO DID THE WORK. A lookup that guesses when the answer is ambiguous produces work signed by an
// account nobody chose, and the only trace of it is in a provider's billing.

// ── AN IDENTITY THAT HANDS NOTHING OVER IS A LABEL ───────────────────────────────────────────────────
// It would register, resolve, boot, and leave the CLI logged out — a session that looks configured while the
// delegate quietly runs as nobody. Refused at the write, where the author is still there to fix it.
export function assertCliIdentityHandsSomethingOver(spec: CliIdentitySpec): void {
  if (Object.keys(spec.env).length > 0 || spec.home.length > 0) return;
  throw new BadRequestError(
    "BAD_REQUEST",
    { cli: spec.cli },
    "a cli-identity must hand something over: set `env` (what the CLI reads from the environment), `home` (what it reads from disk), or both. An identity carrying neither would boot a logged-out CLI and report a configured session.",
  );
}

// What a session decided to run as. Three values, because "you registered none" and "the store could not
// answer" and "here it is" are three different situations and only one of them is a credential (protocol L2).
export type CliIdentityChoice<T> =
  | { kind: "explicit"; identity: T } // a reference was given — it always wins
  | { kind: "mine"; identity: T } // exactly one of the submitter's own matched the CLI
  | { kind: "none" }; // nothing registered; the session runs without one and SAYS so

export interface CliIdentityCandidate {
  id: string;
  version: string;
}

// ── ONE IS A CHOICE, TWO IS A REFUSAL ────────────────────────────────────────────────────────────────
//
// `explicit` beats the implicit lookup, always: "run as the team's CI identity" has to be sayable, and a
// caller who named one has already answered the question this function exists to ask.
//
// With no reference, the submitter's OWN identities for this CLI are the candidates — never the workspace's.
// The mechanism this replaces resolved `secrets.workspace[name] ?? secrets.user?.[name]`, so a team token
// silently outranked every member's own login; repeating that here would defeat the whole point of
// registering one. A workspace-visible identity is something a caller names on purpose.
//
// Two candidates is a REFUSAL naming both. Picking one would be a guess about which of my accounts did the
// work, and a guess that is right most of the time is the worst kind: nobody checks it until the wrong
// account is the one on the invoice.
export function chooseCliIdentity<T extends CliIdentityCandidate>(input: {
  explicit?: T;
  mine: T[];
  cli: string;
}): CliIdentityChoice<T> {
  if (input.explicit !== undefined) return { kind: "explicit", identity: input.explicit };
  const [first, second] = input.mine;
  if (first === undefined) return { kind: "none" };
  if (second !== undefined)
    throw new ConflictError(
      "CONFLICT",
      { cli: input.cli, identities: input.mine.map((i) => i.id) },
      `you have ${input.mine.length} identities registered for '${input.cli}' (${input.mine
        .map((i) => i.id)
        .join(
          ", ",
        )}) — name the one this work runs as, because choosing for you would sign it with an account you did not pick.`,
    );
  return { kind: "mine", identity: first };
}
