// The role→action matrix lives in @everdict/domain; @everdict/auth is the control plane's authz surface, so it
// re-exports the vocabulary here as a deliberate convenience — a consumer imports can/authorize beside the authenticators.
export {
  type Action,
  API_KEY_SCOPES,
  type ApiKeyScope,
  authorize,
  can,
  EVERDICT_ROLES,
  type EverdictRole,
} from "@everdict/domain";
