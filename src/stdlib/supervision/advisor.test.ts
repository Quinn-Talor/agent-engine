import { describe, expect, it } from 'vitest'
import type { StepFacts } from '../../contracts/component.js'
import type { SideModelRequest } from '../../contracts/model.js'
import { modelAdvisor } from './advisor.js'
import { checkAll, failed, facts, guardCtx, tool } from './observations.fixture.js'

/** 超过 50 字的进展说明。 */
const LONG_TEXT =
  '已经查到了两家供应商的报价，接下来对比交付周期和付款条件，再决定推荐哪一家给委托人，目前没有遇到阻碍。'

/** 记录模型调用，按顺序返回回复。 */
function advisorCtx(...replies: Array<string | undefined>) {
  const requests: SideModelRequest[] = []
  const ctx = guardCtx({
    callModel: async (req) => {
      requests.push(req)
      const text = replies.shift()
      return text === undefined
        ? undefined
        : { text, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, model: 'fake:m' }
    },
  })
  return { ctx, requests }
}

const healthy = (step: number) =>
  facts(step, {
    text: LONG_TEXT,
    toolCalls: [tool({ name: `t${step}`, inputHash: `h${step}` })],
    newInformation: true,
  })
/** 收到纠偏后本步全部失败。 */
const troubledAfterSteering = (step: number) =>
  facts(step, {
    text: LONG_TEXT,
    toolCalls: [failed({ name: 'fetch', inputHash: 'h-fetch' })],
    interventions: { applied: [{ kind: 'hint', source: 'steering' }], violated: [] },
  })
const advice = (patch: Record<string, unknown> = {}) =>
  `好的：${JSON.stringify({
    problem: 'fetch 一直超时',
    suggest: '改用缓存数据作答',
    block: [{ tool: 'fetch', inputHash: 'h-fetch' }],
    confidence: 0.8,
    ...patch,
  })}`

describe('modelAdvisor', () => {
  it('AC-037 does not call the model on healthy steps', async () => {
    const { ctx, requests } = advisorCtx()
    const opinions = await checkAll(
      modelAdvisor(),
      Array.from({ length: 10 }, (_, i) => healthy(i + 1)),
      ctx,
    )
    expect(requests).toEqual([])
    expect(opinions.every((o) => o === undefined)).toBe(true)
  })

  it('AC-037 calls the model when a step fails right after steering', async () => {
    const { ctx, requests } = advisorCtx(advice())
    await checkAll(modelAdvisor(), [healthy(1), troubledAfterSteering(2)], ctx)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ purpose: 'supervision:advise', maxOutputTokens: 1024 })
    expect(requests[0]!.system).toContain('只输出一个 JSON 对象')
    const input = JSON.parse(requests[0]!.messages[0]!.content as string)
    expect(input.task).toBe('分析这家公司')
    expect(input.trajectory.map((s: { step: number }) => s.step)).toEqual([1, 2])
    expect(input.trajectory[1].tools[0]).toMatchObject({
      name: 'fetch',
      inputHash: 'h-fetch',
      ok: false,
      errorCode: 'TOOL_EXCEPTION',
    })
  })

  it('AC-037 calls the model every 5 steps when the window looks unhealthy', async () => {
    const { ctx, requests } = advisorCtx()
    const mixed = (step: number, ok: boolean) =>
      facts(step, {
        text: LONG_TEXT,
        toolCalls: [ok ? tool({ name: `t${step}` }) : failed({ name: `t${step}` })],
      })
    await checkAll(
      modelAdvisor(),
      [mixed(1, true), mixed(2, false), mixed(3, true), mixed(4, false), mixed(5, true)],
      ctx,
    )
    expect(requests).toHaveLength(1)

    const quiet = advisorCtx()
    const shortText = (step: number) => ({ ...healthy(step), text: '好' })
    await checkAll(modelAdvisor(), [1, 2, 3, 4, 5].map(shortText), quiet.ctx)
    expect(quiet.requests).toHaveLength(1)

    const looping = advisorCtx()
    const same = (step: number): StepFacts => ({
      ...healthy(step),
      toolCalls: [tool({ name: 'search', inputHash: `h${step}` })],
    })
    await checkAll(modelAdvisor(), [1, 2, 3, 4, 5].map(same), looping.ctx)
    expect(looping.requests).toHaveLength(1)
  })

  it('AC-037 stops after 3 calls and keeps 3 steps between calls', async () => {
    const { ctx, requests } = advisorCtx()
    const sequence = Array.from({ length: 12 }, (_, i) => troubledAfterSteering(i + 1))
    await checkAll(modelAdvisor(), sequence, ctx)
    expect(requests).toHaveLength(3)
    const own = advisorCtx()
    await checkAll(modelAdvisor({ maxCalls: 1, every: 4 }), sequence, own.ctx)
    expect(own.requests).toHaveLength(1)
    expect(modelAdvisor({ model: 'fake:small' }).config).toEqual({
      model: 'fake:small',
      maxCalls: 3,
      every: 5,
      maxOutputTokens: 1024,
    })
  })

  it('AC-038 adopts confident advice and blocks calls from the window', async () => {
    const { ctx } = advisorCtx(advice())
    const [, opinion] = await checkAll(modelAdvisor(), [healthy(1), troubledAfterSteering(2)], ctx)
    expect(opinion).toEqual({
      warn: {
        problem: 'fetch 一直超时',
        suggest: '改用缓存数据作答',
        block: [
          {
            tool: 'fetch',
            inputHash: 'h-fetch',
            code: 'repeat',
            reason: '顾问判断：fetch 一直超时',
            suggest: '改用缓存数据作答',
          },
        ],
      },
      detail: '顾问',
    })
  })

  it.each([
    ['low confidence', advice({ confidence: 0.3 })],
    ['a block outside the window', advice({ block: [{ tool: 'fetch', inputHash: 'other' }] })],
    ['text that is not JSON', '无法判断'],
    ['a missing field', advice({ suggest: '' })],
    ['no answer', undefined],
  ])('AC-038 ignores %s', async (_name, reply) => {
    const { ctx } = advisorCtx(reply)
    const [, opinion] = await checkAll(modelAdvisor(), [healthy(1), troubledAfterSteering(2)], ctx)
    expect(opinion).toBeUndefined()
  })

  it('AC-038 does not block intent or polling calls', async () => {
    for (const patch of [{ intentTool: true as const }, { repeatable: true }]) {
      const { ctx } = advisorCtx(advice({ block: [{ tool: 'finish', inputHash: 'h-finish' }] }))
      const step2 = troubledAfterSteering(2)
      step2.toolCalls.push(tool({ name: 'finish', inputHash: 'h-finish', ...patch }))
      const [, opinion] = await checkAll(modelAdvisor(), [healthy(1), step2], ctx)
      expect(opinion).toBeUndefined()
    }
  })

  it('AC-037 keeps the call limit and given advice for the whole run, across restarts after a steer', async () => {
    const { ctx, requests } = advisorCtx(advice(), advice(), advice(), advice())
    const advisor = modelAdvisor()
    const before = await checkAll(advisor, [1, 2, 3, 4].map(troubledAfterSteering), ctx)
    const after = await checkAll(
      advisor,
      [5, 6, 7, 8, 9, 10, 11, 12].map(troubledAfterSteering),
      ctx,
    )
    expect(requests).toHaveLength(3)
    expect([...before, ...after].filter((o) => o !== undefined)).toHaveLength(1)
  })

  it('AC-038 does not repeat a suggestion it already gave, and may skip the block', async () => {
    const { ctx, requests } = advisorCtx(advice({ block: undefined }), advice())
    const opinions = await checkAll(
      modelAdvisor(),
      [
        troubledAfterSteering(1),
        troubledAfterSteering(2),
        troubledAfterSteering(3),
        troubledAfterSteering(4),
      ],
      ctx,
    )
    expect(requests).toHaveLength(2)
    expect(opinions[0]).toEqual({
      warn: { problem: 'fetch 一直超时', suggest: '改用缓存数据作答' },
      detail: '顾问',
    })
    expect(opinions[3]).toBeUndefined()
  })
})
