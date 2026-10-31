import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AgentDef, Deliverable } from './agent.js'
import type { Capability, Prepared } from './capability.js'
import type { Segment } from './common.js'
import type { Check, Guard, OutputContract } from './component.js'
import type { EnvironmentConfig } from './environment.js'
import type { RunEvent } from './events.js'
import { SCHEMA_VERSION } from './events.js'
import type { RunResult } from './run.js'
import type { Budget, TaskDef } from './task.js'

// 设计 §4.7 的两个示例改写为类型测试：契约必须能直接承载设计里的写法。
const rolePrompt: Segment = { role: 'system', parts: [{ type: 'text', text: 'You are a helper.' }] }
const prepared: Prepared = { tools: [], snapshot: { fingerprint: 'fp' } }
const capability = (id: string, kind: string): Capability => ({
  id,
  version: '1',
  kind,
  prepare: async () => prepared,
})
const component = { id: 'c', version: '1' }
const structuredOutput: OutputContract = {
  ...component,
  id: 'structured',
  kind: 'structured',
  validate: async () => ({ ok: true }),
}
const evidenceRequired: Check = {
  ...component,
  id: 'evidence',
  mode: 'gate',
  start: () => ({ accept: async () => ({ pass: true }) }),
}
const dossierUnchanged: Guard = {
  ...component,
  id: 'dossier-unchanged',
  start: () => ({ check: () => undefined }),
}

describe('contracts accept the design examples', () => {
  it('AC-003 minimal and full business agents type-check', () => {
    const helper: AgentDef = {
      id: 'helper',
      instructions: [rolePrompt],
      capabilities: [capability('helper-tools', 'tool'), capability('intents', 'intents')],
    }
    const deliverable: Deliverable = { output: structuredOutput, checks: [evidenceRequired] }
    const analyst: AgentDef = {
      id: 'analyst',
      instructions: [rolePrompt],
      capabilities: [capability('market-data', 'mcp'), capability('valuation', 'skill')],
      deliverable,
      model: { requires: { minContext: 128_000 } },
    }
    const task: TaskDef = {
      input: [{ role: 'user', parts: [{ type: 'text', text: 'research brief' }] }],
      context: { dossierId: 'd-1', asOf: '2026-01-01' },
      goal: '更新 d-1 的研究简报',
      guards: [dossierUnchanged],
      budget: { maxSteps: 60, maxCost: 2 },
      subject: 'd-1',
    }
    const environment: EnvironmentConfig = {
      name: 'background',
      principal: { reachable: false },
      caps: { toolConcurrency: 5, delegation: { depth: 3 } },
    }
    expect([helper.id, analyst.id, task.subject, environment.name]).toEqual([
      'helper',
      'analyst',
      'd-1',
      'background',
    ])
  })

  it('AC-003 rejects a budget limit that is not a number', () => {
    // @ts-expect-error maxSteps 必须是 number
    const bad: Budget = { maxSteps: '10' }
    expect(bad).toBeDefined()
  })

  it('exposes the outcome statuses and the event schema version', () => {
    expectTypeOf<RunResult['status']>().toEqualTypeOf<
      'completed' | 'awaiting_input' | 'finalized' | 'stopped' | 'failed' | 'aborted'
    >()
    expectTypeOf<Extract<RunEvent, { t: 'step_started' }>>().toHaveProperty('step')
    expect(SCHEMA_VERSION).toBe(1)
  })
})
