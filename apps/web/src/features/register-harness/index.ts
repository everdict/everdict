export { RegisterHarnessWizard, InstanceForm, TemplateForm } from './ui/register-harness-wizard'
export {
  instanceStateFromSpec,
  templateStateFromSpec,
  type InstanceState,
  type TemplateState,
} from './lib/build-spec'
export {
  registerHarnessAction,
  validateHarnessAction,
  type RegisterHarnessResult,
  type ValidateHarnessResult,
} from './api/register-harness'
