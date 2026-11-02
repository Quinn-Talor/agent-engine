import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../contracts/agent.js'
import type { Environment } from '../../contracts/environment.js'
import { isToolError, toolError } from '../../contracts/errors.js'
import type { RunResult } from '../../contracts/run.js'
import type { Task } from '../../contracts/task.js'
import type { ToolCtx } from '../../contracts/tool.js'
import { defineAgent } from '../../core/definition/define.js'
import { emptyRunUsage } from '../../core/run/state.js'
import { delegationHost, type SubagentSpec } from './delegation-host.js'

const agent = (id: string): Agent =>
  defineAgent({
    id,
    instructions: [{ role: 'system', parts: [{ type: 'text', text: `你是 ${id}` }] }],
  })

const spec = (name: string, patch: Partial<SubagentSpec> = {}): SubagentSpec => ({
  name,
  description: `${name} 的职责`,
  agent: agent(name),
  ...patch,
})

const result = (patch: Partial<RunResult>): RunResult => ({
  runId: 'child-1',
  status: 'completed',
  model: 'fake:m',
  usage: emptyRunUsage(),
  steps: 1,
  toolCalls: 0,
  ...patch,
})

function ctxWith(spawn: ToolCtx['spawn'], runId = 'r1'): ToolCtx {
  return {
    runId,
    callId: 'c1',
    idempotencyKey: `${runId}:c1`,
    scope: {},
    task: { subject: 'session-9', context: { dossier: 'D1' } },
    signal: new AbortController().signal,
    spawn,
    progress: () => {},
  }
}

describe('delegationHost', () => {
  it('AC-007 shares one delegate tool per run with every subagent in its enum', () => {
    const host = delegationHost()
    expect(host.kind).toBe('delegation')
    const a = host.register('r1', spec('researcher'))
    const b = host.register('r1', spec('writer'))
    expect(a.tool).toBe(b.tool)
    expect(host.register('r2', spec('researcher')).tool).not.toBe(a.tool)
    expect(a.tool).toMatchObject({ name: 'delegate', execution: { timeoutMs: 86_400_000 } })
    expect(a.tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['researcher', 'writer'] },
        task: { type: 'string', minLength: 1 },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    })
  })

  it('AC-008 spawns the subagent with the task text, parent context and its own settings', async () => {
    const environment = { name: 'strict' } as Environment
    const host = delegationHost()
    const researcher = spec('researcher', {
      budget: { maxTotalMs: 60_000, finalizeReserveMs: 0 },
      environment,
    })
    const { tool } = host.register('r1', researcher)
    const spawn = vi.fn(async (_a: Agent, _t: Task) => result({ text: '找到三家可比公司' }))
    expect(await tool.execute({ agent: 'researcher', task: '找可比公司' }, ctxWith(spawn))).toBe(
      '找到三家可比公司',
    )
    const [spawnedAgent, task, opts] = spawn.mock.calls[0] as unknown as [
      Agent,
      Task,
      { environment: Environment },
    ]
    expect(spawnedAgent).toBe(researcher.agent)
    expect(task).toMatchObject({
      input: [{ role: 'user', parts: [{ type: 'text', text: '找可比公司' }] }],
      subject: 'session-9',
      context: { dossier: 'D1' },
      budget: { maxTotalMs: 60_000, finalizeReserveMs: 0 },
    })
    expect(task.fingerprint).toEqual(expect.any(String))
    expect(opts).toEqual({ environment })
  })

  it('passes the parent workspace on to the subagent', async () => {
    const { tool } = delegationHost().register('r1', spec('researcher'))
    const spawn = vi.fn(async (_a: Agent, _t: Task) => result({ text: 'ok' }))
    const ctx = { ...ctxWith(spawn), scope: { workspace: '/repo' } }
    await tool.execute({ agent: 'researcher', task: '看代码' }, ctx)
    expect((spawn.mock.calls[0] as unknown as [Agent, Task])[1].scope).toEqual({
      workspace: '/repo',
    })
    await tool.execute({ agent: 'researcher', task: '看代码' }, ctxWith(spawn))
    expect((spawn.mock.calls[1] as unknown as [Agent, Task])[1]).not.toHaveProperty('scope')
  })

  it('AC-008 maps completed runs without text to their output, intent or a note', async () => {
    const { tool } = delegationHost().register('r1', spec('researcher'))
    const run = (r: Partial<RunResult>) =>
      tool.execute(
        { agent: 'researcher', task: 't' },
        ctxWith(async () => result(r)),
      )
    expect(await run({ output: { peers: 3 } })).toBe('{"peers":3}')
    expect(await run({ intent: { tool: 'finish', input: { summary: '完成' } } })).toBe(
      '{"summary":"完成"}',
    )
    expect(await run({})).toBe('子 agent 已完成')
  })

  it.each([
    [
      'finalized',
      { status: 'finalized', code: 'stall', text: '只查到一家' },
      '（阶段性结果，子 agent 未完成：stall）\n只查到一家',
    ],
    [
      'awaiting_input',
      { status: 'awaiting_input', code: 'ask_user', text: '要哪个行业？' },
      { code: 'SUBAGENT_NEEDS_INPUT', message: 'ask_user: 要哪个行业？' },
    ],
    [
      'stopped',
      { status: 'stopped', code: 'blocked' },
      { code: 'SUBAGENT_STOPPED', message: 'blocked' },
    ],
    [
      'failed',
      {
        status: 'failed',
        code: 'model_error',
        error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true },
      },
      { code: 'SUBAGENT_FAILED', message: 'model_error: slow down' },
    ],
    [
      'aborted',
      { status: 'aborted', code: 'parent' },
      { code: 'SUBAGENT_ABORTED', message: 'parent' },
    ],
  ] as const)('AC-009 maps a %s child run', async (_name, child, expected) => {
    const { tool } = delegationHost().register('r1', spec('researcher'))
    const out = await tool.execute(
      { agent: 'researcher', task: 't' },
      ctxWith(async () => result(child as Partial<RunResult>)),
    )
    if (typeof expected === 'string') expect(out).toBe(expected)
    else expect(isToolError(out) && out).toMatchObject(expected)
  })

  it('AC-010 rejects names outside the run and passes spawn refusals through', async () => {
    const host = delegationHost()
    const { tool, release } = host.register('r1', spec('researcher'))
    const out = await tool.execute(
      { agent: 'nobody', task: 't' },
      ctxWith(async () => result({})),
    )
    expect(isToolError(out) && out).toMatchObject({
      code: 'INVALID_INPUT',
      message: '子 agent nobody 不在本次运行中',
    })
    const refusal = toolError('SPAWN_CYCLE', '不能委托给自己或祖先：researcher')
    await expect(
      tool.execute(
        { agent: 'researcher', task: 't' },
        ctxWith(async () => Promise.reject(refusal)),
      ),
    ).rejects.toBe(refusal)
    release()
    release()
    expect(
      isToolError(
        await tool.execute(
          { agent: 'researcher', task: 't' },
          ctxWith(async () => result({})),
        ),
      ),
    ).toBe(true)
  })
})
