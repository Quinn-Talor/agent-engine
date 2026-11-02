// 守卫的运行级场景（docs/guard-mechanism.md §6）：用标准守卫跑完整运行，验证先告知、再封路或收尾，
// 健康运行不受打扰，委托人引导之后重来，完成优先于守卫收尾。

import { describe, expect, it } from 'vitest'
import {
  checkInvariants,
  createEngine,
  defineAgent,
  defineTask,
  fakeModel,
  fakeTool,
  memoryArchive,
  modelHub,
  planning,
  runToEnd,
  toolError,
  tools,
  type Capability,
  type FakeReply,
  type Run,
  type RunEvent,
} from '../../../src/index.js'

const quiet = { log: () => {} }

function start(replies: FakeReply[], capabilities: Capability[]): Run {
  const model = fakeModel({ model: 'main', replies })
  const engine = createEngine({
    services: {
      models: modelHub({ providers: [model], default: model.ref }),
      archive: memoryArchive(),
      logger: quiet,
    },
  })
  const agent = defineAgent({
    id: 'agent',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是助手' }] }],
    capabilities,
  })
  const task = defineTask({
    input: [{ role: 'user', parts: [{ type: 'text', text: '查一下东京明天的天气' }] }],
  })
  return engine.environment({ name: 'test', principal: { reachable: true } }).start(agent, task)
}

const call = (name: string, input: unknown, text = '') => ({
  text,
  toolCalls: [{ name, input }],
})
const steeringTexts = (events: readonly RunEvent[]) =>
  events.flatMap((e) =>
    e.t === 'intervention_applied' && e.source === 'steering' && 'hint' in e.intervention
      ? [{ step: e.step, text: e.intervention.hint.text }]
      : [],
  )
const blockedCalls = (events: readonly RunEvent[]) =>
  events.filter((e) => e.t === 'tool_finished' && e.errorCode === 'TOOL_BLOCKED')

describe('guards in a run', () => {
  it('AC-039 blocks a call that timed out twice and finalizes when it is called again', async () => {
    const fetch = fakeTool({
      name: 'fetch',
      effect: 'none',
      run: () => toolError('TOOL_TIMEOUT', '超时'),
    })
    const { result, events } = await runToEnd(
      start(
        [
          call('fetch', { city: '东京' }),
          call('fetch', { city: '东京' }),
          call('fetch', { city: '东京' }),
          { text: '天气服务一直超时，暂时查不到。' },
        ],
        [tools([fetch])],
      ),
    )
    expect(result).toMatchObject({ status: 'finalized', code: 'failure_streak' })
    expect(fetch.calls).toHaveLength(2)
    expect(blockedCalls(events)).toHaveLength(1)
    const [steering] = steeringTexts(events)
    expect(steering!.text).toContain(
      '已封住（再调用将收尾）：\n- fetch：已失败 2 次（TOOL_TIMEOUT）；建议：暂时不可用，不要用相同输入重试',
    )
    // 封路的原因只在封路清单里出现一次；超时不建议"检查参数"。
    expect(steering!.text.match(/已失败 2 次/g)).toHaveLength(1)
    expect(steering!.text).not.toContain('检查参数')
    expect(checkInvariants(events)).toEqual([])
  })

  it('I15 blocks a timed-out payment at once so the model cannot pay twice', async () => {
    let charged = 0
    const pay = fakeTool({
      name: 'pay',
      effect: 'side_effect',
      timeoutMs: 100,
      run: async () => {
        charged += 1
        await new Promise((r) => setTimeout(r, 300))
        return '已扣款'
      },
    })
    const { result, events } = await runToEnd(
      start(
        [
          call('pay', { order: 'A1', amount: 100 }),
          call('pay', { order: 'A1', amount: 100 }),
          { text: '支付结果未知，可能已经扣款，请先在账单里核实。' },
        ],
        [tools([pay])],
      ),
    )
    expect(charged).toBe(1)
    expect(blockedCalls(events)).toHaveLength(1)
    expect(result).toMatchObject({ status: 'finalized' })
    const [steering] = steeringTexts(events)
    expect(steering!.text).toContain('结果未知（TOOL_TIMEOUT），可能已经执行')
    expect(checkInvariants(events)).toEqual([])
  })

  it('AC-040 warns at 2 failing steps and finalizes at 3', async () => {
    const fetch = fakeTool({
      name: 'fetch',
      effect: 'none',
      run: () => toolError('TOOL_TIMEOUT', '超时'),
    })
    const { result, events } = await runToEnd(
      start(
        [
          call('fetch', { city: '东京' }),
          call('fetch', { city: '大阪' }),
          call('fetch', { city: '京都' }),
          { text: '天气服务不可用。' },
        ],
        [tools([fetch])],
      ),
    )
    expect(result).toMatchObject({ status: 'finalized', code: 'failure_streak' })
    const steering = steeringTexts(events)
    expect(steering.map((s) => s.step)).toEqual([3])
    expect(steering[0]!.text).toContain('2/3')
    expect(steering[0]!.text).toContain('目标：查一下东京明天的天气')
    expect(checkInvariants(events)).toEqual([])
  })

  it('AC-009 ends repeated truncation through the fallback with a shorter answer', async () => {
    const cut = { text: '东京明天的天气要从气压分布说起，', finishReason: 'length' as const }
    const { result, events } = await runToEnd(
      start([cut, cut, cut, { text: '东京明天晴，最高 15 度。' }], []),
    )
    expect(result).toMatchObject({
      status: 'finalized',
      code: 'truncated',
      text: '东京明天晴，最高 15 度。',
    })
    const fallback = events.find((e) => e.t === 'fallback_generated')
    expect(fallback).toMatchObject({ code: 'truncated', degradation: 0 })
    expect(checkInvariants(events)).toEqual([])
  })

  it('AC-041 leaves a healthy 20-step run alone', async () => {
    const lookup = fakeTool({ name: 'lookup', run: (input) => `结果：${JSON.stringify(input)}` })
    const replies: FakeReply[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        call('lookup', { day: i }, `已经查到第 ${i} 天的数据，继续查下一天。`),
      ),
      { text: '东京明天晴。' },
    ]
    const { result, events } = await runToEnd(start(replies, [tools([lookup])]))
    expect(result).toMatchObject({ status: 'completed' })
    expect(events.filter((e) => e.t === 'intervention_applied')).toEqual([])
    expect(lookup.calls).toHaveLength(20)
  })

  it('AC-042 does not block a polling tool that keeps returning the same result', async () => {
    const poll = fakeTool({ name: 'poll', repeatable: true, result: '处理中' })
    const replies: FakeReply[] = [
      ...Array.from({ length: 6 }, () => call('poll', { job: 1 }, '任务还在处理，继续等待。')),
      { text: '任务处理完了。' },
    ]
    const { result, events } = await runToEnd(start(replies, [tools([poll])]))
    expect(result).toMatchObject({ status: 'completed' })
    expect(events.some((e) => e.t === 'intervention_applied' && 'block' in e.intervention)).toBe(
      false,
    )
    expect(poll.calls).toHaveLength(6)
  })

  it('AC-043 lifts blocks when the principal steers', async () => {
    let attempts = 0
    const fetch = fakeTool({
      name: 'fetch',
      run: () => (++attempts === 1 ? toolError('INVALID_INPUT', '缺少日期') : '晴'),
    })
    const run = start(
      [call('fetch', { city: '东京' }), call('fetch', { city: '东京' }), { text: '东京明天晴。' }],
      [tools([fetch])],
    )
    run.subscribe({
      onEvent: (e) => {
        if (e.t === 'evaluated' && e.step === 1) run.steer('日期已经补上了，再查一次')
      },
    })
    const { result, events } = await runToEnd(run)
    expect(events.some((e) => e.t === 'intervention_applied' && 'block' in e.intervention)).toBe(
      true,
    )
    expect(fetch.calls).toHaveLength(2)
    expect(blockedCalls(events)).toEqual([])
    expect(result).toMatchObject({ status: 'completed' })
  })

  it('AC-044 completes when the model answers on the step a guard would end', async () => {
    const fetch = fakeTool({
      name: 'fetch',
      effect: 'none',
      run: () => toolError('TOOL_TIMEOUT', '超时'),
    })
    const streak = await runToEnd(
      start(
        [call('fetch', { city: '东京' }), call('fetch', { city: '大阪' }), { text: '查不到。' }],
        [tools([fetch])],
      ),
    )
    expect(streak.result).toMatchObject({ status: 'completed' })

    const lookup = fakeTool({ name: 'lookup', run: (input) => `结果：${JSON.stringify(input)}` })
    const plan = { items: [{ id: '1', text: '查天气', status: 'in_progress' }] }
    const planned = await runToEnd(
      start(
        [
          call('update_plan', plan, '先建立计划。'),
          call('lookup', { city: '东京' }, '正在查天气。'),
          { text: '东京明天晴。' },
        ],
        [tools([lookup]), planning({ thresholds: [1, 2] })],
      ),
    )
    expect(planned.result).toMatchObject({ status: 'completed' })
    const last = planned.events.findLast((e) => e.t === 'evaluated')
    expect(last?.t === 'evaluated' && last.opinions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'capability:progress',
          opinion: { finalize: { code: 'no_progress' } },
        }),
      ]),
    )
    expect(checkInvariants(planned.events)).toEqual([])
  })
})
