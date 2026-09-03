import { z } from "zod";

// ── OPENING A WORLD THROUGH A SESSION API (docs/architecture/world-and-engagement-model.md) ──────────
//
// A world that is opened per case and closed after it — a desktop, a per-run app instance, a browser — is
// reached by asking a service for one. That contract already existed for a browser TARGET
// (`TargetAcquireSchema`, `mode: "service"`); this is the same shape with one owner, so an environment and a
// target speak the same protocol and the coordinates come back under the same names.
//
// It lives under `execution/` rather than `harness/` for the reason the build recipe does: `harness/` already
// imports from `execution/`, so a shape both need belongs here or a cycle closes.
export const SessionAcquireSchema = z.object({
  // Session start — "POST /sessions" (method + path; `{var}` interpolation from the wiring vocabulary).
  open: z.string().min(1),
  // wiring variable name → dot-path in the open response JSON (e.g. `{ target_base_url: "url" }`).
  coordinates: z.record(z.string().min(1), z.string().min(1)),
  // Session cleanup — "DELETE /sessions/{session_id}". Absent = the service expires it on its own, which is
  // the honest default: the session service owns the lifetime and an early close is a courtesy this platform
  // extends, never a teardown it can certify.
  close: z.string().min(1).optional(),
});
export type SessionAcquire = z.infer<typeof SessionAcquireSchema>;
