// The role→action matrix now lives in @everdict/domain — re-architecture P1b compat re-export
// (removed in the P4 sweep). New code should import @everdict/domain directly.
export {
  type Action,
  API_KEY_SCOPES,
  type ApiKeyScope,
  authorize,
  can,
  EVERDICT_ROLES,
  type EverdictRole,
} from "@everdict/domain";
