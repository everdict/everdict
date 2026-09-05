// The reserved owner of first-party (Everdict-authored) built-ins — a mirror of the contract's FIRST_PARTY_TENANT (the web imports no VALUES
// from @everdict/* — types only). A built-in is a code definition rather than a DB row, and the control plane merges it into the public catalog:
// it cannot be edited or deleted, and it attaches to every workspace's agent with no adoption (turning it off is Settings › Agent).
export const BUILT_IN_TENANT = '_everdict'

export const isBuiltInCapability = (capability: { tenant: string }): boolean =>
  capability.tenant === BUILT_IN_TENANT
