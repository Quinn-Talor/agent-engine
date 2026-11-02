import { describe, expect, it, vi } from 'vitest'
import type { Candidate, ComponentCtx, Corpus, SideModelRequest } from '../../sdk.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { obs } from '../supervision/observations.fixture.js'
import { completionReview, riskScore } from './completion-review.js'

type Source = Corpus['sources'][number]
const input = (text: string): Source => ({ origin: 'input', text })
const tool = (patch: Partial<Source> = {}): Source => ({
  origin: 'tool',
  text: 'ok',
  callId: 'c',
  toolName: 'read',
  effect: 'none',
  isError: false,
  ...patch,
})
const corpus = (...sources: Source[]): Corpus => ({ sources })
const candidate = (text: string, step = 1): Candidate => ({ step, text, observation: obs(step) })

describe('riskScore', () => {
  it.each([
    ['an action request without tool calls', corpus(input('请创建一个文件')), '好的', 1, 5],
    ['a booking request without tool calls', corpus(input('帮我订一张明天的机票')), '好的', 1, 5],
    ['a write claim without side effects', corpus(input('看看'), tool()), '已保存到文件', 1, 4],
    [
      'several items with few tool calls',
      corpus(input('请完成：\n1. 收集\n2. 分析\n3. 报告'), tool()),
      '这是一份完整而详细的报告，覆盖了收集分析与结论三个部分的主要内容和关键数据。',
      1,
      3,
    ],
    ['a long request with a short answer', corpus(input('请'.repeat(101)), tool()), '好', 1, 2],
    ['an all-done claim after five steps', corpus(input('看看'), tool()), '全部完成', 5, 4],
    [
      'an unfinished plan',
      corpus(
        input('看看'),
        tool({
          toolName: 'update_plan',
          text: '<tool_output>\n计划已更新：已完成 1/3 项\n</tool_output>',
        }),
      ),
      '这是结果说明，内容足够长，不会触发其他任何一项打分规则，只看计划的完成情况。',
      1,
      3,
    ],
  ])('AC-007 scores %s', (_name, c, text, step, score) => {
    expect(riskScore(candidate(text, step), c)).toBe(score)
  })

  it.each([
    ['预订明天的酒店', 5],
    ['帮我订购三本书', 5],
    ['帮我订明天去上海的机票', 5],
    ['下单买一台显示器', 5],
    ['Please order a pizza for the team', 5],
    ['Can you delete the temp files?', 5],
    ['能帮我订一张机票吗？', 5],
    ['请修订这段文字的错别字', 0],
    ['制订一份学习计划', 0],
    ['查一下订单状态', 5],
    ['帮我查明天北京到上海的航班', 5],
    ['搜索一下最近的发布记录', 5],
    ['Look up the exchange rate for JPY', 5],
    ['检查一下这段代码的问题', 0],
    ['总结一下这段文字', 0],
    ['怎么查看 git 日志？', 0],
    ['I need a summary in order to plan the week', 0],
    ['List the steps in the order of priority', 0],
    ['怎么删除一个 git 分支？', 0],
    ['How do I cancel a subscription?', 0],
    ['订单什么时候发货？', 0],
    ['如何部署这个服务', 0],
    ['检查是否有新版本并更新依赖', 5],
  ])('scores the action request %s without tools as %i', (text, score) => {
    expect(
      riskScore(candidate('这是一段足够长的回答，用来避开短回答的打分规则。'), corpus(input(text))),
    ).toBe(score)
  })

  it('does not count a write claim backed by a successful side effect', () => {
    const c = corpus(input('看看'), tool({ effect: 'side_effect' }))
    expect(riskScore(candidate('已保存到文件'), c)).toBe(0)
    const failed = corpus(input('看看'), tool({ effect: 'side_effect', isError: true }))
    expect(riskScore(candidate('已保存到文件'), failed)).toBe(4)
    expect(riskScore(candidate('all tasks are done', 4), corpus(input('x'), tool()))).toBe(0)
    const finished = corpus(
      input('x'),
      tool({ toolName: 'update_plan', text: '计划已更新：已完成 3/3 项' }),
    )
    expect(
      riskScore(
        candidate('结果说明，内容足够长，不会触发其他任何一项打分规则，只看计划的完成情况。'),
        finished,
      ),
    ).toBe(0)
  })
})

describe('riskScore for a reply that only announces an action', () => {
  const question = corpus(input('北京明天天气怎么样？'))
  const long = '北京明天晴，最高 12 度，最低 1 度，北风四级，早晚温差大，出门记得带外套。'

  it.each([
    ['好的，我先查一下北京明天的天气。'],
    ['稍等，我马上为你查询。'],
    ['让我调用天气工具看看。'],
    ['接下来我会为你获取最新的天气数据。'],
    ['Sure, let me look that up for you.'],
    ["I'll check the forecast now."],
  ])('scores %s', (text) => {
    expect(riskScore(candidate(text), question)).toBe(5)
  })

  it.each([
    [long],
    [`让我总结一下：${long}${long}`],
    [`${long}如果需要，我可以再帮你查一下其他城市。`],
    ["Tomorrow will be sunny in Beijing. I'll be happy to help with anything else."],
  ])('does not score an answer: %s', (text) => {
    expect(riskScore(candidate(text), question)).toBe(0)
  })

  it('adds up with an unanswered lookup request', () => {
    expect(riskScore(candidate('好的，我先查一下。'), corpus(input('查一下北京明天的天气')))).toBe(
      10,
    )
  })
})

describe('riskScore with an unreachable principal', () => {
  const asking = candidate('还需要几个信息：出发城市是哪里？')
  const c = corpus(input('帮我查明天的航班'), tool())

  it('scores a reply that asks the principal when the principal cannot answer', () => {
    expect(riskScore(asking, c, { principalReachable: false })).toBe(3)
    expect(
      riskScore(candidate('请告诉我出发城市和到达城市。'), c, { principalReachable: false }),
    ).toBe(3)
    expect(riskScore(asking, c, { principalReachable: true })).toBe(0)
    expect(riskScore(asking, c)).toBe(0)
    expect(riskScore(candidate('明天北京晴。'), c, { principalReachable: false })).toBe(0)
  })

  it('counts only question marks that end a sentence', () => {
    const unreachable = { principalReachable: false }
    expect(riskScore(candidate('报告见 https://x.example/r?id=1&v=2 。'), c, unreachable)).toBe(0)
    expect(riskScore(candidate('Which city do you mean? I can continue.'), c, unreachable)).toBe(3)
    expect(riskScore(candidate('Which city do you mean?'), c, unreachable)).toBe(3)
    expect(riskScore(candidate('出发城市是哪里？到达城市已经确定。'), c, unreachable)).toBe(3)
  })
})

function setup(reply: string | undefined | Error) {
  const requests: SideModelRequest[] = []
  const logs: string[] = []
  const ctx = {
    log: (_l: string, m: string) => logs.push(m),
    callModel: vi.fn(async (req: SideModelRequest) => {
      requests.push(req)
      if (reply instanceof Error) throw reply
      return reply === undefined
        ? undefined
        : {
            text: reply,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            model: 'fake:m',
          }
    }),
  } as unknown as ComponentCtx
  return { ctx, requests, logs }
}

const risky = corpus(input('请创建一个文件'))
const accept = (
  ctx: ComponentCtx,
  c = risky,
  text = '好的',
  opts?: Parameters<typeof completionReview>[0],
) => completionReview(opts).start(runInfo(), ctx).accept(candidate(text), c)

describe('completionReview', () => {
  it('AC-022 identifies itself and defaults to gate with two attempts', () => {
    expect(completionReview()).toMatchObject({
      id: 'completion',
      version: '3',
      mode: 'gate',
      maxAttempts: 2,
      config: { model: null },
    })
    expect(
      completionReview({ model: 'fake:small', mode: 'annotate', maxAttempts: 1 }),
    ).toMatchObject({
      mode: 'annotate',
      maxAttempts: 1,
      config: { model: 'fake:small' },
    })
  })

  it('AC-006 passes low-risk deliveries without calling the model', async () => {
    const { ctx } = setup('{}')
    expect(await accept(ctx, corpus(input('看看'), tool()), '看过了')).toEqual({ pass: true })
    expect(ctx.callModel).not.toHaveBeenCalled()
  })

  it('AC-008 fails when the model lists unfinished items with enough confidence', async () => {
    const { ctx, requests } = setup(
      '结论：{"complete": false, "confidence": 0.8, "missing": ["创建文件"]}',
    )
    expect(await accept(ctx, risky, '好的', { model: 'fake:small' })).toEqual({
      pass: false,
      issues: ['创建文件'],
      hint: '以下事项还没有完成：\n- 创建文件\n缺少需要的工具时，先用 search_tool 查找。',
    })
    expect(requests[0]).toMatchObject({
      purpose: 'check:completion',
      model: 'fake:small',
      maxOutputTokens: 512,
    })
    expect(JSON.parse(requests[0]!.messages[0]!.content as string)).toEqual({
      task: '请创建一个文件',
      answer: '好的',
      tools: [],
    })
  })

  it('tells the judge and the model that the principal cannot answer questions', async () => {
    const { ctx, requests } = setup(
      '{"complete": false, "confidence": 0.9, "missing": ["出发城市和到达城市"]}',
    )
    const c = corpus(input('帮我查明天的航班'), tool())
    const verdict = await completionReview()
      .start(runInfo(false), ctx)
      .accept(candidate('请告诉我出发城市和到达城市？'), c)
    expect(verdict).toEqual({
      pass: false,
      issues: ['出发城市和到达城市'],
      hint: '以下事项还没有完成：\n- 出发城市和到达城市\n委托人联系不上，不会回答提问：能基于已有信息完成就直接给出结果；缺少关键信息无法继续时，用 report_blocked 说明缺什么。',
    })
    expect(requests[0]!.system).toContain('委托人联系不上')
    expect(JSON.parse(requests[0]!.messages[0]!.content as string)).toMatchObject({
      principalReachable: false,
    })
  })

  it('AC-008 leaves out the search hint when tools were used', async () => {
    const { ctx } = setup('{"complete": false, "confidence": 0.9, "missing": ["第二项"]}')
    const c = corpus(
      input('请完成：\n1. 收集\n2. 分析\n3. 报告'),
      tool({ toolName: 'update_plan', text: '计划已更新：已完成 1/3 项' }),
    )
    const result = await accept(
      ctx,
      c,
      '做完了第一项，结果如下：收集了足够的数据并整理成表格，以供后续使用和参考。',
    )
    expect(result).toEqual({
      pass: false,
      issues: ['第二项'],
      hint: '以下事项还没有完成：\n- 第二项',
    })
  })

  it('tells the judge and the model that announcing an action is not doing it', async () => {
    const { ctx, requests } = setup(
      '{"complete": false, "confidence": 0.9, "missing": ["没有查询天气"]}',
    )
    const c = corpus(input('北京明天天气怎么样？'), tool({ toolName: 'search_tool' }))
    const result = await accept(ctx, c, '好的，我先查一下北京明天的天气。')
    expect(result).toEqual({
      pass: false,
      issues: ['没有查询天气'],
      hint: '以下事项还没有完成：\n- 没有查询天气\n要做的事直接调用工具去做，不要只说明打算。',
    })
    expect(requests[0]!.system).toContain('只是在预告')
  })

  it.each([
    ['complete', '{"complete": true, "confidence": 0.9, "missing": []}'],
    ['low confidence', '{"complete": false, "confidence": 0.4, "missing": ["x"]}'],
    ['no missing items', '{"complete": false, "confidence": 0.9, "missing": []}'],
    ['not json', '我觉得没做完'],
    ['broken json', '{"complete": false,'],
    ['skipped by the supervision share', undefined],
  ])('AC-009 passes when the model answer is %s', async (_name, reply) => {
    expect(await accept(setup(reply).ctx)).toEqual({ pass: true })
  })

  it('AC-009 passes and logs when the model call fails', async () => {
    const { ctx, logs } = setup(new Error('down'))
    expect(await accept(ctx)).toEqual({ pass: true })
    expect(logs).toEqual(['完成审查调用失败'])
  })
})
