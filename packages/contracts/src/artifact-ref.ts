// ── THE ARTIFACT HANDLE, DECLARED AT THE DEPENDENCY ROOT ─────────────────────────────────────────────
//
// `artifact://<key>` is the stable handle a record stores for bytes that live in the object store. It used to
// be declared in `@everdict/application-control` beside the port that mints it, which was the right home
// while only that layer cared. It stopped being right when `contracts` had to answer a question about it:
// a producer may not hand us one (arch-review 121), and the schema that refuses is here, at the root.
//
// A scheme is a WIRE fact — it appears in stored records and in submitted documents — so it belongs with the
// other wire declarations rather than with the adapter that happens to write it. `application-control` keeps
// the minting and parsing helpers and imports the scheme from here, so there is one spelling.
export const ARTIFACT_REF_SCHEME = "artifact://";
