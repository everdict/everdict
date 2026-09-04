import { describe, expect, it } from 'vitest'

import type { HarnessTemplateSpec } from '@/entities/harness'

import {
  baselineFromTemplate,
  buildInstance,
  buildOverrides,
  EMPTY_BASELINE,
  INITIAL_INSTANCE,
  instanceStateFromSpec,
  type InstanceState,
} from './build-spec'

// A command template carrying env/params/model defaults — the shape an instance layers a delta on.
const commandTemplate: HarnessTemplateSpec = {
  kind: 'command',
  category: 'cli-agent',
  id: 'aider',
  version: '1.0.0',
  image: 'ghcr.io/acme/aider:1',
  command: 'aider --message {{task}} --edit-format {{edit_format}}',
  setup: [],
  env: { OPENAI_BASE_URL: 'http://litellm:4000', LOG_LEVEL: 'info' },
  params: { edit_format: 'whole' },
}

const serviceTemplate: HarnessTemplateSpec = {
  kind: 'service',
  category: 'topology',
  id: 'bu',
  version: '2',
  services: [
    {
      name: 'planner',
      needs: [],
      perRun: [],
      replicas: 1,
      env: { MODEL: 'claude-opus-4-8', TEMPERATURE: '0.2' },
      resources: { cpu: 1000, memoryMb: 2048 },
    },
    { name: 'browser', needs: [], perRun: [], replicas: 1, env: {} },
  ],
  frontDoor: {
    service: 'planner',
    submit: 'POST /runs',
    request: { bodyTemplate: { max_steps: 30 } },
    completion: { mode: 'poll', timeoutMs: 120000, intervalMs: 1000 },
  },
}

describe('baselineFromTemplate', () => {
  it('carries the template env/params so the instance form can show inherited values', () => {
    const baseline = baselineFromTemplate(commandTemplate)
    expect(baseline.known).toBe(true)
    expect(baseline.cmdEnvRows).toEqual([
      { key: 'OPENAI_BASE_URL', secret: false, value: 'http://litellm:4000' },
      { key: 'LOG_LEVEL', secret: false, value: 'info' },
    ])
    expect(baseline.cmdParams).toBe('edit_format=whole')
  })

  it('carries per-service env/resources and the front-door body/completion', () => {
    const baseline = baselineFromTemplate(serviceTemplate)
    expect(baseline.services.map((s) => s.service)).toEqual(['planner', 'browser'])
    expect(baseline.services[0]?.cpu).toBe('1000')
    expect(baseline.services[0]?.memoryMb).toBe('2048')
    expect(JSON.parse(baseline.bodyTemplate)).toEqual({ max_steps: 30 })
    expect(baseline.completionTimeout).toBe('120000')
  })
})

describe('instanceStateFromSpec with a baseline', () => {
  it('prefills the EFFECTIVE env (template ⊕ the instance delta), not the delta alone', () => {
    const baseline = baselineFromTemplate(commandTemplate)
    const state = instanceStateFromSpec(
      {
        template: { id: 'aider', version: '1.0.0' },
        id: 'aider-verbose',
        version: 'v3',
        pins: { image: 'ghcr.io/acme/aider:3' },
        overrides: { env: { LOG_LEVEL: 'debug' } },
      },
      ['image', 'model'],
      baseline
    )
    // The inherited OPENAI_BASE_URL has to stay ON SCREEN, or a person goes off to edit the template.
    expect(state.cmdEnvRows).toEqual([
      { key: 'OPENAI_BASE_URL', secret: false, value: 'http://litellm:4000' },
      { key: 'LOG_LEVEL', secret: false, value: 'debug' },
    ])
    expect(state.cmdParams).toBe('edit_format=whole')
  })

  it('keeps the harness name so a new version never lands under a different harness', () => {
    const state = instanceStateFromSpec(
      {
        template: { id: 'aider', version: '1.0.0' },
        id: 'aider-verbose',
        version: 'v3',
        pins: {},
      },
      ['image'],
      baselineFromTemplate(commandTemplate)
    )
    expect(state.id).toBe('aider-verbose')
    expect(buildInstance(state).id).toBe('aider-verbose')
  })

  it('opens one row per template service, merging the delta onto the inherited values', () => {
    const baseline = baselineFromTemplate(serviceTemplate)
    const state = instanceStateFromSpec(
      {
        template: { id: 'bu', version: '2' },
        id: 'bu',
        version: 'main',
        pins: {},
        overrides: { services: { planner: { env: { TEMPERATURE: '0.9' } } } },
      },
      ['planner', 'browser'],
      baseline
    )
    expect(state.serviceOverrides.map((r) => r.service)).toEqual(['planner', 'browser'])
    expect(state.serviceOverrides[0]?.env).toEqual([
      { key: 'MODEL', secret: false, value: 'claude-opus-4-8' },
      { key: 'TEMPERATURE', secret: false, value: '0.9' },
    ])
    expect(state.serviceOverrides[0]?.cpu).toBe('1000')
  })

  it('a key the instance unset stays off the screen — what you see is what runs', () => {
    const baseline = baselineFromTemplate(commandTemplate)
    const s = instanceStateFromSpec(
      {
        template: { id: 'aider', version: '1.0.0' },
        id: 'aider-direct',
        version: 'v2',
        pins: {},
        overrides: { unsetEnv: ['OPENAI_BASE_URL'] },
      },
      ['image', 'model'],
      baseline
    )
    expect(s.cmdEnvRows.map((r) => r.key)).toEqual(['LOG_LEVEL'])
    // Saving it again unchanged preserves the meaning (a round trip).
    expect(buildOverrides(s, baseline)).toEqual({ unsetEnv: ['OPENAI_BASE_URL'] })
  })
})

describe('buildOverrides against a baseline', () => {
  const state = (patch: Partial<InstanceState>): InstanceState => ({
    ...INITIAL_INSTANCE,
    templateId: 'aider',
    templateVersion: '1.0.0',
    ...patch,
  })

  it('emits nothing when the effective config still equals the template', () => {
    const baseline = baselineFromTemplate(commandTemplate)
    const s = state({ cmdEnvRows: baseline.cmdEnvRows, cmdParams: baseline.cmdParams })
    expect(buildOverrides(s, baseline)).toBeUndefined()
  })

  it('emits only the keys that differ', () => {
    const baseline = baselineFromTemplate(commandTemplate)
    const s = state({
      cmdEnvRows: [
        { key: 'OPENAI_BASE_URL', secret: false, value: 'http://litellm:4000' },
        { key: 'LOG_LEVEL', secret: false, value: 'debug' },
        { key: 'EXTRA', secret: false, value: '1' },
      ],
      cmdParams: 'edit_format=diff',
    })
    expect(buildOverrides(s, baseline)).toEqual({
      env: { LOG_LEVEL: 'debug', EXTRA: '1' },
      params: { edit_format: 'diff' },
    })
  })

  it('does not re-emit a per-service value the instance left inherited', () => {
    const baseline = baselineFromTemplate(serviceTemplate)
    const s = state({
      templateId: 'bu',
      templateVersion: '2',
      serviceOverrides: baseline.services.map((r) => ({ ...r })),
      bodyTemplate: baseline.bodyTemplate,
      completionTimeout: baseline.completionTimeout,
      completionInterval: baseline.completionInterval,
      cmdCpu: baseline.cmdCpu,
      cmdMemoryMb: baseline.cmdMemoryMb,
    })
    expect(buildOverrides(s, baseline)).toBeUndefined()
  })

  it('re-states the inherited half of resources — a scalar REPLACE would otherwise drop the template cpu', () => {
    const baseline = baselineFromTemplate(serviceTemplate)
    const planner = baseline.services[0]
    if (!planner) throw new Error('fixture')
    const s = state({
      templateId: 'bu',
      templateVersion: '2',
      serviceOverrides: [{ ...planner, memoryMb: '8192' }],
      bodyTemplate: baseline.bodyTemplate,
      completionTimeout: baseline.completionTimeout,
      completionInterval: baseline.completionInterval,
    })
    expect(buildOverrides(s, baseline)).toEqual({
      services: { planner: { resources: { cpu: 1000, memoryMb: 8192 } } },
    })
  })

  it('a deleted inherited env row becomes unsetEnv (the only way to refuse a template default)', () => {
    const baseline = baselineFromTemplate(commandTemplate)
    const s = state({
      cmdEnvRows: baseline.cmdEnvRows.filter((r) => r.key !== 'OPENAI_BASE_URL'),
      cmdParams: baseline.cmdParams,
    })
    expect(buildOverrides(s, baseline)).toEqual({ unsetEnv: ['OPENAI_BASE_URL'] })
  })

  it('a per-service model change is a delta on that service, not a template edit', () => {
    const baseline = baselineFromTemplate(serviceTemplate)
    const planner = baseline.services[0]
    if (!planner) throw new Error('fixture')
    const s = state({
      templateId: 'bu',
      templateVersion: '2',
      serviceOverrides: [{ ...planner, model: 'claude-opus-4-8' }],
      bodyTemplate: baseline.bodyTemplate,
      completionTimeout: baseline.completionTimeout,
      completionInterval: baseline.completionInterval,
    })
    expect(buildOverrides(s, baseline)).toEqual({
      services: { planner: { model: 'claude-opus-4-8' } },
    })
  })

  it('a command instance can ask for a bigger box without forking the shape', () => {
    const baseline = baselineFromTemplate({ ...commandTemplate, resources: { cpu: 1000 } })
    const s = state({
      cmdEnvRows: baseline.cmdEnvRows,
      cmdParams: baseline.cmdParams,
      cmdCpu: '4000',
      cmdMemoryMb: baseline.cmdMemoryMb,
    })
    expect(buildOverrides(s, baseline)).toEqual({ resources: { cpu: 4000 } })
  })

  it('without a baseline every entered value is a delta (the free-form path is unchanged)', () => {
    const s = state({ cmdEnvRows: [{ key: 'LOG_LEVEL', secret: false, value: 'debug' }] })
    expect(buildOverrides(s, EMPTY_BASELINE)).toEqual({ env: { LOG_LEVEL: 'debug' } })
  })
})

describe('buildInstance', () => {
  it('falls back to the template id only when no harness name was given', () => {
    const s: InstanceState = { ...INITIAL_INSTANCE, templateId: 'bu', version: 'v1' }
    expect(buildInstance(s).id).toBe('bu')
    expect(buildInstance({ ...s, id: 'bu-opus' }).id).toBe('bu-opus')
  })
})
