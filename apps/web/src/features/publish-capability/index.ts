export { CapabilityStore } from './ui/capability-store'
// The store detail — rendered by a ROUTE (`/[workspace]/store/[source]/[id]`) rather than a dialog.
export { CapabilityDetailView } from './ui/capability-detail-view'
export { capKey, storeItemHref, type StoreVariant } from './lib/capability-display'
// The code tool verification panel (check/run) — shared by the store detail and the Settings › Agent › Tools detail under the same execution contract.
export { CodeTryPanel, type CodeTryTargetBuilder } from './ui/code-try-panel'
export { EnvironmentWorkbench } from './ui/environment-workbench'
export {
  saveCapabilityAction,
  type SaveCapabilityInput,
  type SaveCapabilityActionResult,
} from './api/manage-capabilities'
