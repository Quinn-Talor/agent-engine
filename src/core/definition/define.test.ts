import { describe, expect, it } from 'vitest'
import type { AgentDef } from '../../contracts/agent.js'
import type { Capability } from '../../contracts/capability.js'
import type { JsonValue, ModelMessage, Segment } from '../../contracts/common.js'
import type { Check, Guard, OutputContract } from '../../contracts/component.js'
import { DefinitionError } from '../../contracts/errors.js'
import type { TaskDef } from '../../contracts/task.js'
import { defineAgent, defineTask } from './define.js'

const segment = (text: string, role: Segment['role'] = 'system'): Segment => ({
  role,
  parts: [{ type: 'text', text }],
})
const capability = (id: string): Capability => ({
  id,
  version: '1',
  kind: 'tool',
  prepare: async () => ({ tools: [], snapshot: { fingerprint: id } }),
})
const output: OutputContract = {
  id: 'text',
  version: '1',
  kind: 'text',
  validate: async () => ({ ok: true }),
}
const guard = (id: string): Guard => ({
  id,
  version: '1',
  start: () => ({ check: () => undefined }),
})
const check = (id: string): Check => ({
  id,
  version: '1',
  mode: 'gate',
  start: () => ({ accept: async () => ({ pass: true }) }),
})

function issuesOf(fn: () => unknown): { code: string; issues: readonly string[] } {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(DefinitionError)
    const e = error as DefinitionError
    return { code: e.code, issues: e.issues }
  }
  throw new Error('expected DefinitionError')
}

describe('defineAgent', () => {
  const valid: AgentDef = {
    id: 'helper',
    instructions: [segment('help')],
    capabilities: [capability('tools')],
  }

  it('AC-009 returns a frozen agent with a fingerprint', () => {
    const agent = defineAgent(valid)
    expect(agent.id).toBe('helper')
    // F19：复制一份再冻结，能力对象本身沿用原引用。
    expect(agent.capabilities).toEqual(valid.capabilities)
    expect(agent.capabilities).not.toBe(valid.capabilities)
    expect(agent.capabilities![0]).toBe(valid.capabilities![0])
    expect(Object.isFrozen(agent.capabilities)).toBe(true)
    expect(agent.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(agent)).toBe(true)
  })

  it('AC-010 reports every problem at once', () => {
    const { prepare: _omitted, ...broken } = capability('broken')
    const { code, issues } = issuesOf(() =>
      defineAgent({
        id: '',
        instructions: [],
        capabilities: [capability('search'), capability('search'), broken as Capability],
        deliverable: { output, checks: [check('evidence'), check('evidence')] },
      }),
    )
    expect(code).toBe('invalid_agent')
    expect(issues).toEqual([
      'id 不合法',
      'instructions 不能为空',
      'capabilities[2] 缺少 prepare',
      '能力 id 重复：search',
      '验收 id 重复：evidence',
    ])
  })

  it.each<[string, Partial<AgentDef>, string]>([
    ['empty version', { version: '' }, 'version 必须是非空字符串'],
    [
      'bad segment role',
      { instructions: [{ role: 'tool' as never, parts: [] }] },
      'instructions[0] role 不合法',
    ],
    ['non-object capability', { capabilities: [null as never] }, 'capabilities[0] 不是对象'],
    [
      'exposure without start',
      { toolbox: { exposure: { id: 'x', version: '1' } as never } },
      'toolbox.exposure 缺少 start',
    ],
    [
      'negative maxRepairs',
      { deliverable: { output: { ...output, maxRepairs: -1 } } },
      'deliverable.output.maxRepairs 必须是 ≥ 0 的整数',
    ],
    [
      'empty fallback text',
      { deliverable: { output, fallback: { instructions: {}, fixedText: '' } } },
      'deliverable.fallback.fixedText 必须是非空字符串',
    ],
    [
      'minContext not positive',
      { model: { requires: { minContext: 0 } } },
      'model.requires.minContext 必须是正整数',
    ],
    [
      'unserialisable capability config',
      {
        capabilities: [{ ...capability('c'), config: { f: () => 1 } as unknown as JsonValue }],
      },
      '配置不可序列化：canonicalJson: unsupported type function',
    ],
  ])('rejects %s', (_name, patch, issue) => {
    expect(issuesOf(() => defineAgent({ ...valid, ...patch })).issues).toContain(issue)
  })
})

describe('defineTask', () => {
  const input = [segment('do it', 'user')]
  const call = (...ids: string[]): ModelMessage => ({
    role: 'assistant',
    content: ids.map((id) => ({
      type: 'tool-call',
      toolCallId: id,
      toolName: 'search',
      input: {},
    })),
  })
  const result = (...ids: string[]): ModelMessage => ({
    role: 'tool',
    content: ids.map((id) => ({
      type: 'tool-result',
      toolCallId: id,
      toolName: 'search',
      output: 'ok',
    })),
  })

  it('AC-009 returns a frozen task with a fingerprint', () => {
    const task = defineTask({ input, subject: 's-1' })
    expect(task.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(task)).toBe(true)
  })

  it('AC-011 reports every problem at once', () => {
    const { code, issues } = issuesOf(() =>
      defineTask({
        input: [],
        history: [{ role: 'user', content: 'hi' }, call('call-1')],
        budget: { maxCost: -1 },
        context: { f: (() => 1) as unknown as JsonValue },
      }),
    )
    expect(code).toBe('invalid_task')
    expect(issues).toEqual([
      'input 不能为空',
      '工具调用 call-1 缺少结果',
      'context 必须是 JSON 对象',
      'budget.maxCost 必须是 > 0 的有限数',
    ])
  })

  it('accepts tool results split across consecutive tool messages', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'go' },
      call('call-1', 'call-2'),
      result('call-1'),
      result('call-2'),
      { role: 'assistant', content: 'done' },
    ]
    expect(() => defineTask({ input, history })).not.toThrow()
  })

  it.each<[string, Partial<TaskDef>, string]>([
    [
      'unknown tool result',
      { history: [call('call-1'), result('call-1', 'call-9')] },
      '多余的工具结果：call-9',
    ],
    [
      'call interrupted by a user message',
      { history: [call('call-1'), { role: 'user', content: 'x' }, result('call-1')] },
      '工具调用 call-1 缺少结果',
    ],
    [
      'bad history role',
      { history: [{ role: 'robot', content: 'x' } as never] },
      'history[0] role 不合法',
    ],
    ['relative workspace', { scope: { workspace: 'src' } }, 'workspace 必须是绝对路径'],
    [
      'reserve equal to total',
      { budget: { maxTotalMs: 1000, finalizeReserveMs: 1000 } },
      'budget.finalizeReserveMs 必须小于 maxTotalMs',
    ],
    ['fractional maxSteps', { budget: { maxSteps: 1.5 } }, 'budget.maxSteps 必须是 ≥ 1 的整数'],
    ['non-positive maxCost', { budget: { maxCost: 0 } }, 'budget.maxCost 必须是 > 0 的有限数'],
    ['empty subject', { subject: '' }, 'subject 必须是非空字符串'],
    ['non-string tag', { tags: { a: 1 as never } }, 'tags.a 必须是字符串'],
    [
      'AC-028 a guard without start',
      { guards: [{ id: 'g', version: '1' } as never] },
      'guards[0] 缺少 start',
    ],
    ['AC-028 duplicate guard ids', { guards: [guard('g'), guard('g')] }, '守卫 id 重复：g'],
    ['AC-028 an empty goal', { goal: '' }, 'goal 必须是非空字符串'],
    [
      'AC-028 an unknown onError',
      { guards: [{ ...guard('g'), onError: 'x' as never }] },
      'guards[0].onError 必须是 ignore 或 stop',
    ],
    [
      'a guard config holding a non-finite number',
      { guards: [{ ...guard('g'), config: { limit: Infinity } }] },
      '配置不可序列化：canonicalJson: non-finite number',
    ],
  ])('rejects %s', (_name, patch, issue) => {
    const { code, issues } = issuesOf(() => defineTask({ input, ...patch }))
    expect(code).toBe('invalid_task')
    expect(issues).toContain(issue)
  })

  it('accepts guards, an onError policy and a goal', () => {
    const guards = [guard('a'), { ...guard('b'), onError: 'stop' as const }]
    expect(() => defineTask({ input, goal: '订机票', guards })).not.toThrow()
  })

  it('accepts windows and absolute posix workspaces', () => {
    for (const workspace of ['/repo', 'C:\\repo', 'D:/repo', '\\\\server\\share']) {
      expect(() => defineTask({ input, scope: { workspace } })).not.toThrow()
    }
  })
})
