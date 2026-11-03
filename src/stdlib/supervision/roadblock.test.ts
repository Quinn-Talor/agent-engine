import { describe, expect, it } from 'vitest'
import type { CallBlock, GuardOpinion, StepToolFact } from '../../contracts/component.js'
import { checkAll, failed, factSteps, tool } from './observations.fixture.js'
import { roadblock } from './roadblock.js'

type Warn = Extract<GuardOpinion, { warn: unknown }>

const blocksOf = (o: GuardOpinion | undefined): CallBlock[] =>
  o !== undefined && 'warn' in o ? (o.warn.block ?? []) : []

/** 每步一个调用。 */
const run = (...calls: StepToolFact[]) =>
  checkAll(roadblock(), factSteps(...calls.map((c) => ({ toolCalls: [c] }))))

describe('roadblock', () => {
  it.each([
    ['INVALID_INPUT', 'failure_streak', '按错误信息修正参数后再调用：输入不同就不受封路影响'],
    [
      'PERMISSION_DENIED',
      'failure_streak',
      '被规则拒绝：本次任务里不要重试，也不要换工具或换写法去做同一件事；向委托人说明原因，或只做不受限制的部分',
    ],
    [
      'USER_DENIED',
      'user_denied',
      '委托人拒绝了这个操作：本次任务里不要重试，也不要换工具或换写法去做同一件事；改做其他部分，或询问委托人',
    ],
    ['SPAWN_LIMIT', 'spawn_failed', '子任务无法启动；自己完成，或调整委托方式'],
  ])(
    'AC-011 blocks a call after one deterministic %s failure with code %s',
    async (code, blockCode, suggest) => {
      const [opinion] = await run(
        failed({ name: 'f', errorCode: code, errorClass: 'deterministic' }),
      )
      expect(blocksOf(opinion)).toEqual([
        {
          tool: 'f',
          inputHash: 'h1',
          code: blockCode,
          reason: `确定性错误 ${code}，同样的输入会得到同样的结果`,
          suggest,
        },
      ])
      expect((opinion as Warn).warn.problem).toBe('1 个调用不会再有不同结果，已封住')
      expect(opinion!.detail).toBe(`f: 确定性错误 ${code}，同样的输入会得到同样的结果`)
    },
  )

  it('AC-012 blocks a transiently failing call at its second failure, even with steps between', async () => {
    const timeout = failed({ name: 'fetch', errorCode: 'TOOL_TIMEOUT', errorClass: 'transient' })
    const opinions = await run(timeout, tool({ name: 'other', inputHash: 'h2' }), timeout)
    expect(opinions.slice(0, 2)).toEqual([undefined, undefined])
    expect(blocksOf(opinions[2])).toEqual([
      {
        tool: 'fetch',
        inputHash: 'h1',
        code: 'failure_streak',
        reason: '已失败 2 次（TOOL_TIMEOUT）',
        suggest: '暂时不可用，不要用相同输入重试；改用其他工具，或基于已有信息作答',

        clearOnChange: true,
      },
    ])
  })

  it('blocks a side effect with an unknown result at its first failure', async () => {
    const pay = failed({
      name: 'pay',
      effect: 'side_effect',
      errorCode: 'TOOL_TIMEOUT',
      errorClass: 'transient',
      possiblyExecuted: true,
    })
    const [opinion] = await run(pay)
    expect(blocksOf(opinion)).toEqual([
      {
        tool: 'pay',
        inputHash: 'h1',
        code: 'failure_streak',
        reason: '结果未知（TOOL_TIMEOUT），可能已经执行',
        suggest: '先核实是否已经执行（例如查询状态），不要用相同输入重试',
      },
    ])
  })

  it('AC-012 uses external_failure for an unavailable dependency', async () => {
    const down = failed({ name: 'fetch', errorCode: 'TOOL_UNAVAILABLE', errorClass: 'transient' })
    const opinions = await run(down, down)
    expect(blocksOf(opinions[1])[0]!.code).toBe('external_failure')
  })

  it('treats a failure without error code as transient', async () => {
    const odd = { ...failed({ name: 'x' }), errorCode: undefined }
    const opinions = await run(odd, odd)
    expect(opinions[0]).toBeUndefined()
    expect(blocksOf(opinions[1])[0]).toMatchObject({
      code: 'failure_streak',
      reason: '已失败 2 次（）',
    })
  })

  it('AC-013 blocks a call that returns the same output twice in a row', async () => {
    const same = tool({ name: 'read', outputHash: 'o1' })
    const opinions = await run(same, same)
    expect(opinions[0]).toBeUndefined()
    expect(blocksOf(opinions[1])).toEqual([
      {
        tool: 'read',
        inputHash: 'h1',
        code: 'repeat',
        reason: '连续 2 次返回相同结果',
        suggest: '结果没有变化，不要再用相同输入调用；基于已有结果决定下一步',
        clearOnChange: true,
      },
    ])
  })

  it('AC-013 skips repeatable, intent and already blocked calls', async () => {
    const polling = tool({ name: 'poll', outputHash: 'o1', repeatable: true })
    const finish = tool({ name: 'finish', outputHash: 'o1', intentTool: true })
    const hit = failed({ name: 'x', errorCode: 'TOOL_BLOCKED', blocked: true })
    expect(await run(polling, polling, polling)).toEqual([undefined, undefined, undefined])
    expect(await run(finish, finish, finish)).toEqual([undefined, undefined, undefined])
    expect(await run(hit, hit, hit)).toEqual([undefined, undefined, undefined])
  })

  it('AC-014 blocks a side effect after its second success with the same input', async () => {
    const send = (out: string) => tool({ name: 'send', effect: 'side_effect', outputHash: out })
    const opinions = await run(send('o1'), send('o2'), send('o3'))
    expect(opinions[0]).toBeUndefined()
    expect(blocksOf(opinions[1])).toEqual([
      {
        tool: 'send',
        inputHash: 'h1',
        code: 'repeat',
        reason: '有副作用的操作已用相同输入成功执行 2 次',
        suggest: '不要重复执行；需要结果时引用上一次的输出',
        clearOnChange: true,
      },
    ])
    expect(opinions[2]).toBeUndefined()
  })

  it.each(['none', 'idempotent'] as const)(
    'AC-014 does not block %s calls with changing outputs',
    async (effect) => {
      const read = (out: string) => tool({ name: 'read', effect, outputHash: out })
      expect(await run(read('o1'), read('o2'), read('o3'))).toEqual([
        undefined,
        undefined,
        undefined,
      ])
    },
  )

  it('blocks several calls in one step and joins distinct suggestions', async () => {
    const a = failed({ name: 'a', errorCode: 'INVALID_INPUT', errorClass: 'deterministic' })
    const b = failed({
      name: 'b',
      inputHash: 'h2',
      errorCode: 'USER_DENIED',
      errorClass: 'deterministic',
    })
    const [opinion] = await checkAll(roadblock(), factSteps({ toolCalls: [a, b] }))
    expect((opinion as Warn).warn.problem).toBe('2 个调用不会再有不同结果，已封住')
    expect((opinion as Warn).warn.suggest).toBe(
      '按错误信息修正参数后再调用：输入不同就不受封路影响；委托人拒绝了这个操作：本次任务里不要重试，也不要换工具或换写法去做同一件事；改做其他部分，或询问委托人',
    )
    expect(blocksOf(opinion).map((b) => b.tool)).toEqual(['a', 'b'])
  })

  it('keys calls by tool name and input hash', async () => {
    const one = tool({ name: 'read', inputHash: 'h1', outputHash: 'o1' })
    const two = tool({ name: 'read', inputHash: 'h2', outputHash: 'o1' })
    expect(await run(one, two)).toEqual([undefined, undefined])
  })

  it('F25 AC-001 marks blocks that depend on the environment', async () => {
    const [failure] = await run(
      failed({ name: 'run', errorCode: 'TOOL_FAILED', errorClass: 'deterministic' }),
    )
    expect(blocksOf(failure)[0]).toMatchObject({ tool: 'run', clearOnChange: true })
    const same = tool({ name: 'status', outputHash: 'same' })
    const opinions = await run(same, same)
    expect(blocksOf(opinions[1])[0]).toMatchObject({ code: 'repeat', clearOnChange: true })
  })

  it('F25 AC-002 leaves blocks that do not depend on the environment unmarked', async () => {
    const unknown = failed({
      name: 'send',
      effect: 'side_effect',
      errorCode: 'TOOL_TIMEOUT',
      possiblyExecuted: true,
    })
    const opinions = [
      ...(await run(unknown)),
      ...(await run(failed({ errorCode: 'SPAWN_LIMIT', errorClass: 'deterministic' }))),
      ...(await run(failed({ errorCode: 'INVALID_INPUT', errorClass: 'deterministic' }))),
    ]
    for (const o of opinions.filter((x) => x !== undefined)) {
      expect(blocksOf(o)[0]!.clearOnChange).toBeUndefined()
    }
    expect(opinions.filter((x) => x !== undefined)).toHaveLength(3)
  })

  it('F25 AC-003 counts a call again after a write succeeded', async () => {
    const boom = failed({ name: 'run', errorCode: 'TOOL_FAILED', errorClass: 'deterministic' })
    const fix = tool({ name: 'fix', inputHash: 'h9', effect: 'side_effect' })
    const opinions = await run(boom, fix, boom)
    expect(blocksOf(opinions[0])).toHaveLength(1)
    expect(opinions[1]).toBeUndefined()
    expect(blocksOf(opinions[2])[0]).toMatchObject({ tool: 'run', clearOnChange: true })

    // 瞬时失败：失败一次 → 写操作 → 再失败一次，不算连续 2 次
    const flaky = failed({ name: 'test', errorCode: 'TOOL_FAILED', errorClass: 'transient' })
    expect(await run(flaky, fix, flaky)).toEqual([undefined, undefined, undefined])

    // 重复执行副作用：中间有别的写操作不算重复；没有就照旧封住，且带标记
    const script = tool({ name: 'bash', inputHash: 'h5', effect: 'side_effect' })
    expect(await run(script, fix, script)).toEqual([undefined, undefined, undefined])
    const repeated = await run(script, script)
    expect(blocksOf(repeated[1])[0]).toMatchObject({ code: 'repeat', clearOnChange: true })
  })
})
