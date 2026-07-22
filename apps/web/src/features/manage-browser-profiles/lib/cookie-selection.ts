// Site-agnostic cookie classification for profile capture (browser-profiles). One login sets many cookies —
// analytics, UI prefs, consent, plus the actual session token — and the user shouldn't hand-pick a dozen of them.
// We auto-select the ones that look like authentication from the cookie's NAME + flags alone (cookie values never
// reach the client). httpOnly is the strongest signal: session/auth tokens are hidden from JS, whereas analytics
// and preference cookies must be JS-readable. Heuristic, not perfect — the chips let the user adjust, and each
// cookie shows why it was (de)selected.

export interface PreviewCookie {
  name: string
  expires: number | null // unix seconds; null = a session cookie (dies with the browser)
  httpOnly: boolean
  secure: boolean
}

export type CookieCategory = 'auth' | 'session' | 'analytics' | 'preference' | 'other'

// Names that read as authentication across sites (session ids, tokens, login/account state, CSRF, the __Host-/
// __Secure- cookie prefixes browsers reserve for secure cookies).
const AUTH_NAME =
  /sess(ion)?|sid|auth|token|login|logged.?in|remember|credential|csrf|xsrf|jwt|sso|oauth|account|identity|__(host|secure)-/i
// Well-known analytics / tracking / experiment cookies — never login material.
const ANALYTICS_NAME =
  /^_ga|^_gid|^_gat|^_gcl|^_fbp|^_octo|amplitude|mixpanel|segment|^ajs|intercom|hotjar|^_hj|optimizely|^utm|doubleclick|adroll|^_pk|matomo|^__utm|_bucket|experiment|^ab_/i
// UI preferences / consent / infra hints — safe to drop.
const PREFERENCE_NAME =
  /color.?mode|theme|^tz$|timezone|^lang$|locale|^i18n|preferred|consent|cookieconsent|gdpr|ccpa|last_write|^_dc/i

export function classifyCookie(c: PreviewCookie): CookieCategory {
  if (c.httpOnly || AUTH_NAME.test(c.name)) return c.expires === null ? 'session' : 'auth'
  if (ANALYTICS_NAME.test(c.name)) return 'analytics'
  if (PREFERENCE_NAME.test(c.name)) return 'preference'
  return 'other'
}

// A persistent cookie whose expiry has passed — the browser would have dropped it, and re-seeding it into an eval
// browser (Network.setCookies with a past expiry) sets a cookie that dies instantly. Session cookies never expire
// this way (expires === null).
export function isExpired(c: PreviewCookie, nowSeconds: number): boolean {
  return c.expires !== null && c.expires <= nowSeconds
}

// The default selection: keep non-expired auth/session cookies, drop the rest. The user can always override.
export function defaultKeepCookie(c: PreviewCookie, nowSeconds: number): boolean {
  if (isExpired(c, nowSeconds)) return false
  const category = classifyCookie(c)
  return category === 'auth' || category === 'session'
}
