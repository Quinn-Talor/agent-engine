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

  const TEMPERATURE = 'model.settings.temperature 必须是 0 到 2 之间的数'
  const TOP_P = 'model.settings.topP 必须大于 0、不超过 1'
  it.each<[string, { temperature?: number; topP?: number }, string]>([
    ['a temperature below 0', { temperature: -0.1 }, TEMPERATURE],
    ['a temperature above 2', { temperature: 2.1 }, TEMPERATURE],
    ['a temperature that is not a number', { temperature: Number.NaN }, TEMPERATURE],
    ['a topP of 0', { topP: 0 }, TOP_P],
    ['a topP above 1', { topP: 1.5 }, TOP_P],
  ])('AC-004 rejects %s', (_name, settings, issue) => {
    const issues = issuesOf(() => defineAgent({ ...valid, model: { settings } })).issues
    expect(issues).toEqual([issue])
  })

  it('AC-004 accepts the boundary sampling settings and freezes them', () => {
    for (const settings of [{ temperature: 0, topP: 1 }, { temperature: 2 }]) {
      const agent = defineAgent({ ...valid, model: { settings } })
      expect(agent.model?.settings).toEqual(settings)
      expect(Object.isFrozen(agent.model?.settings)).toBe(true)
    }
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

describe('media in definitions', () => {
  const b64 = (bytes: number) => Buffer.alloc(bytes).toString('base64')
  const image = (data: string | Uint8Array, mediaType?: string): Segment['parts'][number] => ({
    type: 'image',
    image: data,
    ...(mediaType ? { mediaType } : {}),
  })
  const file = (data: string | Uint8Array, mediaType: string): Segment['parts'][number] => ({
    type: 'file',
    data,
    mediaType,
  })
  const task =
    (...parts: Segment['parts']) =>
    () =>
      defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: 'x' }, ...parts] }] })

  it.each<[string, () => unknown, string]>([
    ['an image URL', task(image('https://example.com/a.png')), '不接受网址'],
    ['a file URL', task(file('file:///etc/passwd', 'text/plain')), '不接受网址'],
  ])('AC-002 rejects %s', (_name, fn, issue) => {
    const { code, issues } = issuesOf(fn)
    expect(code).toBe('invalid_task')
    expect(issues.join('\n')).toContain(issue)
  })

  it.each<[string, () => unknown, string]>([
    ['an image over the limit', task(image(b64(5_242_881))), '图片过大：5242881 字节'],
    [
      'a file over the limit',
      task(file(new Uint8Array(33_554_433), 'application/pdf')),
      '文件过大',
    ],
    [
      'more than 20 media',
      task(...Array.from({ length: 21 }, () => image(b64(3)))),
      '图片与文件合计 21 个，上限 20',
    ],
    ['data that is not base64', task(image('!!!')), '数据不是 base64'],
    ['a data URL that is not base64', task(image('data:image/png,abc')), 'base64 形式'],
    [
      'an unsupported file type',
      task(file(b64(3), 'application/zip')),
      '不支持的文件类型 application/zip',
    ],
    ['an image part typed as PDF', task(image(b64(3), 'application/pdf')), '不是图片'],
    ['a file without a media type', task(file(b64(3), '')), '文件缺少 mediaType'],
  ])('AC-003 rejects %s', (_name, fn, issue) => {
    const { code, issues } = issuesOf(fn)
    expect(code).toBe('invalid_task')
    expect(issues.join('\n')).toContain(issue)
  })

  it('AC-003 accepts the limits and every data form', () => {
    expect(task(image(b64(5_242_880)))).not.toThrow()
    expect(task(...Array.from({ length: 20 }, () => image(b64(3))))).not.toThrow()
    expect(task(image(new Uint8Array(4)), file(new Uint8Array(4), 'application/pdf'))).not.toThrow()
    expect(
      task(image(`data:image/png;base64,${b64(3)}`), file(b64(3), 'text/markdown')),
    ).not.toThrow()
  })

  it('AC-003 counts media in history, volatile and tool result images', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: Array.from({ length: 8 }, () => image(b64(3))) },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c', toolName: 's', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c',
            toolName: 's',
            output: '',
            images: Array.from({ length: 8 }, () => ({ type: 'image' as const, image: b64(3) })),
          },
        ],
      },
    ]
    const volatile: Segment[] = [
      { role: 'user', parts: Array.from({ length: 5 }, () => image(b64(3))) },
    ]
    const { issues } = issuesOf(() =>
      defineTask({ input: [segment('x', 'user')], history, volatile }),
    )
    expect(issues).toEqual(['图片与文件合计 21 个，上限 20'])
    const bad: ModelMessage[] = [{ role: 'user', content: [image('https://x.test/a.png')] }]
    expect(
      issuesOf(() => defineTask({ input: [segment('x', 'user')], history: bad })).issues[0],
    ).toContain('不接受网址')
  })

  it('AC-004 checks agent instructions, keepRecentImages and required inputs', () => {
    const base: AgentDef = { id: 'a', instructions: [segment('help')] }
    const issues = (patch: Partial<AgentDef>) => issuesOf(() => defineAgent({ ...base, ...patch }))
    expect(
      issues({ instructions: [{ role: 'system', parts: [image('https://x.test/a.png')] }] }),
    ).toMatchObject({ code: 'invalid_agent' })
    for (const keepRecentImages of [0, 1.5]) {
      expect(issues({ model: { settings: { keepRecentImages } } }).issues).toEqual([
        'model.settings.keepRecentImages 必须是 ≥ 1 的整数',
      ])
    }
    expect(issues({ model: { requires: { inputs: ['pdf', 'gif' as never] } } }).issues).toEqual([
      'model.requires.inputs 含未知模态 gif',
    ])
    expect(() =>
      defineAgent({
        ...base,
        model: { requires: { inputs: ['image'] }, settings: { keepRecentImages: 1 } },
      }),
    ).not.toThrow()
  })
})
