import { describe, expect, it } from 'vitest'
import type { AgentDef } from '../contracts/agent.js'
import type { Capability } from '../contracts/capability.js'
import type { Guard, Memory, PermissionRule } from '../contracts/component.js'
import type { EnvironmentConfig } from '../contracts/environment.js'
import type { TaskDef } from '../contracts/task.js'
import {
  agentFingerprint,
  componentIdentity,
  engineFingerprint,
  environmentFingerprint,
  taskFingerprint,
} from './fingerprint.js'

const guard = (id: string): Guard => ({
  id,
  version: '1',
  start: () => ({ check: () => undefined }),
})

const capability = (id: string, config?: Record<string, number>, version = '1'): Capability => ({
  id,
  version,
  kind: 'tool',
  config,
  prepare: async () => ({ tools: [], snapshot: { fingerprint: id } }),
})

const agent = (patch: Partial<AgentDef> = {}): AgentDef => ({
  id: 'analyst',
  version: '1.0.0',
  instructions: [{ role: 'system', parts: [{ type: 'text', text: 'analyse' }] }],
  capabilities: [capability('search', { limit: 5 }), capability('fetch')],
  ...patch,
})

describe('agentFingerprint', () => {
  const base = agentFingerprint(agent())

  it('AC-006 ignores the business version tag', () => {
    expect(agentFingerprint(agent({ version: '2.0.0' }))).toBe(base)
  })

  it.each<[string, Partial<AgentDef>]>([
    ['instructions', { instructions: [{ role: 'system', parts: [{ type: 'text', text: 'x' }] }] }],
    [
      'capability config',
      { capabilities: [capability('search', { limit: 6 }), capability('fetch')] },
    ],
    [
      'capability version',
      { capabilities: [capability('search', { limit: 5 }, '2'), capability('fetch')] },
    ],
    [
      'capability order',
      { capabilities: [capability('fetch'), capability('search', { limit: 5 })] },
    ],
  ])('AC-006 changes when %s changes', (_name, patch) => {
    expect(agentFingerprint(agent(patch))).not.toBe(base)
  })

  it('is insensitive to key order in the definition', () => {
    const def = agent()
    const reordered: AgentDef = {
      capabilities: def.capabilities,
      instructions: def.instructions,
      id: def.id,
    }
    expect(agentFingerprint(reordered)).toBe(agentFingerprint({ ...def, version: undefined }))
  })

  it('distinguishes default exposure and deliverable from explicit ones', () => {
    const exposure = { id: 'search', version: '1', start: () => ({ visible: () => [] }) }
    expect(agentFingerprint(agent({ toolbox: { exposure } }))).not.toBe(base)
  })
})

describe('taskFingerprint', () => {
  const task = (patch: Partial<TaskDef> = {}): TaskDef => ({
    input: [{ role: 'user', parts: [{ type: 'text', text: 'brief' }] }],
    context: { dossierId: 'd-1' },
    budget: { maxSteps: 60 },
    subject: 'd-1',
    tags: { source: 'ui' },
    ...patch,
  })
  const base = taskFingerprint(task())

  it.each<[string, Partial<TaskDef>]>([
    ['context', { context: { dossierId: 'd-2' } }],
    ['budget', { budget: { maxSteps: 61 } }],
    ['goal', { goal: '订一张去东京的机票' }],
    ['guards', { guards: [guard('g')] }],
  ])('AC-007 AC-029 changes when %s changes', (_name, patch) => {
    expect(taskFingerprint(task(patch))).not.toBe(base)
  })

  it('AC-029 changes when a task guard version or onError changes', () => {
    const one = taskFingerprint(task({ guards: [guard('g')] }))
    expect(taskFingerprint(task({ guards: [{ ...guard('g'), version: '2' }] }))).not.toBe(one)
    expect(taskFingerprint(task({ guards: [{ ...guard('g'), onError: 'stop' }] }))).not.toBe(one)
  })

  it.each<[string, Partial<TaskDef>]>([
    ['subject', { subject: 'd-9' }],
    ['tags', { tags: { source: 'api' } }],
    ['volatile', { volatile: [{ role: 'user', parts: [{ type: 'text', text: '2026-10-30' }] }] }],
  ])('AC-007 ignores %s', (_name, patch) => {
    expect(taskFingerprint(task(patch))).toBe(base)
  })
})

describe('environment and engine fingerprints', () => {
  const rule: PermissionRule = { id: 'sandbox', version: '1', permit: async () => 'allow' }
  const config = (patch: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
    name: 'interactive',
    principal: { reachable: true },
    notice: [{ role: 'system', parts: [{ type: 'text', text: 'org rules' }] }],
    ...patch,
  })
  const base = environmentFingerprint(config())

  it('AC-008 changes with principal reachability and permissions', () => {
    expect(environmentFingerprint(config({ principal: { reachable: false } }))).not.toBe(base)
    expect(environmentFingerprint(config({ permissions: [rule] }))).not.toBe(base)
  })

  it('AC-008 ignores the approver implementation', () => {
    const approver = { approve: async () => ({ approved: true }) }
    expect(environmentFingerprint(config({ principal: { reachable: true, approver } }))).toBe(base)
  })

  it('AC-029 changes with environment guard config', () => {
    const one = environmentFingerprint(config({ guards: [guard('g')] }))
    expect(one).not.toBe(base)
    expect(
      environmentFingerprint(config({ guards: [{ ...guard('g'), config: { n: 2 } }] })),
    ).not.toBe(one)
  })

  it('treats notice providers by identity and segments by content', () => {
    const provider = { id: 'hook', version: '1', provide: async () => [] }
    expect(environmentFingerprint(config({ notice: [provider] }))).not.toBe(base)
  })

  it('AC-029 engine fingerprint changes with the guard list', () => {
    const memory: Memory = {
      id: 'compacting',
      version: '1',
      start: () => ({ recall: async () => ({ history: [], transcript: [] }) }),
    }
    expect(engineFingerprint({ memory, guards: [guard('a'), guard('b')] })).not.toBe(
      engineFingerprint({ memory, guards: [guard('a')] }),
    )
  })

  it('changes with the default deliverable and exposure the engine fills in', () => {
    const memory: Memory = {
      id: 'compacting',
      version: '1',
      start: () => ({ recall: async () => ({ history: [], transcript: [] }) }),
    }
    const output = {
      id: 'text',
      version: '1',
      kind: 'text' as const,
      validate: async () => ({ ok: true as const }),
    }
    const review = {
      id: 'completion',
      version: '3',
      mode: 'gate' as const,
      start: () => ({ accept: async () => ({ pass: true as const }) }),
    }
    const exposure = { id: 'all', version: '1', start: () => ({ visible: () => [] }) }
    const plain = engineFingerprint({ memory, guards: [], deliverable: { output }, exposure })
    expect(
      engineFingerprint({
        memory,
        guards: [],
        deliverable: { output, checks: [review] },
        exposure,
      }),
    ).not.toBe(plain)
    expect(
      engineFingerprint({
        memory,
        guards: [],
        deliverable: { output },
        exposure: { ...exposure, id: 'search' },
      }),
    ).not.toBe(plain)
  })
})

describe('componentIdentity', () => {
  it('defaults the mode to active and hashes the config', () => {
    const identity = componentIdentity({ id: 'x', version: '1' })
    expect(identity).toMatchObject({ id: 'x', version: '1', mode: 'active' })
    expect(identity).not.toEqual(componentIdentity({ id: 'x', version: '1', config: { k: 1 } }))
  })
})
