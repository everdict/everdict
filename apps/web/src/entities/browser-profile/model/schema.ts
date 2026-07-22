import type { BrowserProfileRecord } from '@everdict/contracts'
import { z } from 'zod'

// Saved authenticated browser profile (browser-profiles S2). Runtime boundary validation stays here (zod v4); the
// EXPORTED type comes from @everdict/contracts (the wire record is the SSOT). `import type` only — never a value
// from @everdict/*. Identical-shape entity, so the drift guard is bidirectional.
export const browserProfileSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  cookieDomains: z.array(z.string()),
  country: z.string().nullable(), // the geo (egress-proxy country) the login session ran through — null = direct
  capturedAt: z.string().nullable(), // when the login was last captured (S3), or null if none yet
  expiresAt: z.string().nullable(), // earliest captured-cookie expiry — null = session-only / nothing captured
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const browserProfilesSchema = z.array(browserProfileSchema)

// Drift guard — the local schema and the wire contract MUST stay mutually assignable. A renamed/dropped/added field
// or a retype on EITHER side stops one binding compiling and the web typecheck fails.
type AssertAssignable<A extends B, B> = A
type WebBrowserProfile = z.infer<typeof browserProfileSchema>
type _fwd = AssertAssignable<WebBrowserProfile, BrowserProfileRecord>
type _back = AssertAssignable<BrowserProfileRecord, WebBrowserProfile>

export type BrowserProfile = BrowserProfileRecord

// Reference the guards so unused-type lint never strips them.
export type __browserProfileDriftGuard = [_fwd, _back]
