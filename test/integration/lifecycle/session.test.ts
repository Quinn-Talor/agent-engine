// 会话的端到端场景（会话方案 §6–§12）：真实的 compactingMemory、进程中断后的下一轮、委托里的副作用台账。
// 每个场景最后都用 sessionLogIssues 复核 I17。

import { describe, expect, it } from 'vitest'
import {
  createEngine,
  defineAgent,
  defineTask,
  memoryArchive,
  modelHub,
  subagent,
  toolContent,
  tools,
  type ArchiveStore,
  type ModelInput,
  type RunEvent,
} from '../../../src/index.js'
import { fakeModel, fakeTool, sessionLogIssues, type FakeReply } from '../../../src/testing.js'

const quiet = { log: () => {} }
const ask = (text: string) =>
  defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text }] }] })
const instructions = [
  { role: 'system' as const, parts: [{ type: 'text' as const, text: '你是助手' }] },
]

const read = async (archive: ArchiveStore, runId: string) => {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}
const builtOf = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { t: 'context_built' }> => e.t === 'context_built')
const isSummaryRequest = (input: ModelInput) =>
  input.messages.some(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('结构化摘要'),
  )

/** 按轮给出模型的回复；摘要请求交给 `summarize`。 */
function scripted(summarize: (input: ModelInput) => string) {
  let plan: FakeReply[] = []
  const summaries: string[] = []
  const reply = (input: ModelInput): FakeReply => {
    if (isSummaryRequest(input)) {
      summaries.push(input.messages.at(-1)!.content as string)
      return { text: summarize(input) }
    }
    return plan.shift() ?? { text: '收尾' }
  }
  return { reply, summaries, next: (p: FakeReply[]) => (plan = p) }
}

const lookups = (n: number, prefix: string): FakeReply[] =>
  Array.from({ length: n }, (_, i) => ({
    toolCalls: [{ id: `${prefix}-${i}`, name: 'lookup', input: { q: `${prefix}${i}` } }],
  }))

describe('sessions end to end', () => {
  // 窗口 4000、输出 500：输入上限 3500；每次查询的结果约 670 token。
  const lookup = fakeTool({ name: 'lookup', result: '资料'.repeat(500) })
  const agent = defineAgent({ id: 'helper', instructions, capabilities: [tools([lookup])] })
  const small = { contextLimit: 4_000, maxOutputTokens: 500 }

  it('AC-014 compacts in the run, at the turn start, and merges into the carried summary', async () => {
    let n = 0
    const script = scripted(() => `摘要 ${++n}`)
    const model = fakeModel({
      model: 'main',
      replies: [script.reply],
      repeatLast: true,
      capabilities: small,
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        logger: quiet,
      },
    })
    const env = engine.environment({ name: 'chat', principal: { reachable: true } })
    const turns = [
      [...lookups(5, 'a'), { text: '第一轮的答复' }],
      [...lookups(2, 'b'), { text: '第二轮的答复' }],
      [{ text: '第三轮的答复' }],
    ]
    const reasons: string[] = []
    for (const [i, plan] of turns.entries()) {
      script.next(plan)
      const run = env.start(agent, ask(`第 ${i + 1} 个问题`), { session: 's' })
      expect(await run.result).toMatchObject({ status: 'completed' })
      for (const b of builtOf(await read(archive, run.runId))) {
        if (b.compaction?.reason) reasons.push(b.compaction.reason)
        expect(b.estimate).toBeLessThan(3_500)
      }
    }
    expect(reasons).toContain('in_run')
    expect(reasons).toContain('turn_start')
    expect(script.summaries.some((s) => s.includes('【已有摘要】\n摘要'))).toBe(true)
    expect(await sessionLogIssues(archive, 's')).toEqual([])
  })

  it('AC-014 drops the earliest turns when compaction keeps failing, and the chain still checks out', async () => {
    const script = scripted(() => '')
    const model = fakeModel({
      model: 'main',
      replies: [script.reply],
      repeatLast: true,
      capabilities: small,
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        logger: quiet,
      },
    })
    const env = engine.environment({ name: 'chat', principal: { reachable: true } })
    const reasons: string[] = []
    for (let i = 0; i < 5; i++) {
      script.next([...lookups(2, `t${i}`), { text: `第 ${i + 1} 轮的答复` }])
      const run = env.start(agent, ask(`第 ${i + 1} 个问题`), { session: 's' })
      await run.result
      for (const b of builtOf(await read(archive, run.runId))) {
        if (b.compaction?.reason) reasons.push(b.compaction.reason)
      }
    }
    expect(reasons).toContain('overflow_drop')
    expect(await sessionLogIssues(archive, 's')).toEqual([])
  })

  it('AC-015 carries an interrupted turn into the next one after a restart', async () => {
    const archive = memoryArchive()
    let called!: () => void
    const reached = new Promise<void>((resolve) => (called = resolve))
    // 第 1 个进程：发律师函时进程"崩溃"——工具一直不返回，运行没有结尾。
    const hanging = fakeTool({
      name: 'send',
      effect: 'side_effect',
      timeoutMs: 600_000,
      run: () => {
        called()
        return new Promise(() => {})
      },
    })
    const firstModel = fakeModel({
      model: 'main',
      replies: [{ toolCalls: [{ id: 'c1', name: 'send', input: { to: '星河科技' } }] }],
    })
    const first = createEngine({
      services: {
        models: modelHub({ providers: [firstModel], default: firstModel.ref }),
        archive,
        logger: quiet,
      },
    })
    const sender = defineAgent({ id: 'helper', instructions, capabilities: [tools([hanging])] })
    first.environment({ name: 'chat', principal: { reachable: true } }).start(sender, ask('发函'), {
      session: 's',
    })
    await reached

    // 第 2 个进程启动：补齐中断的运行，再开下一轮。
    const send = fakeTool({ name: 'send', effect: 'side_effect', result: '已发出' })
    const secondModel = fakeModel({
      model: 'main',
      replies: [{ text: '上一封函可能已经发出，先确认' }],
    })
    const second = createEngine({
      services: {
        models: modelHub({ providers: [secondModel], default: secondModel.ref }),
        archive,
        logger: quiet,
      },
    })
    const next = second
      .environment({ name: 'chat', principal: { reachable: true } })
      .start(
        defineAgent({ id: 'helper', instructions, capabilities: [tools([send])] }),
        ask('发了吗'),
        {
          session: 's',
        },
      )
    expect(await next.result).toMatchObject({ status: 'completed' })
    const seen = JSON.stringify(secondModel.inputs[0]!.messages)
    expect(seen).toContain('【第 1 轮结局】aborted（interrupted）')
    expect(seen).toContain('TOOL_INTERRUPTED')
    const started = (await read(archive, next.runId)).find((e) => e.t === 'run_started')
    expect(started?.t === 'run_started' && started.session?.window.ledger).toEqual([
      { turn: 1, tool: 'send', input: '{"to":"星河科技"}', status: 'possibly_executed' },
    ])
    expect(await sessionLogIssues(archive, 's')).toEqual([])
  })

  it('AC-016 puts the side effects of a delegated child run into the next ledger', async () => {
    const send = fakeTool({ name: 'send', effect: 'side_effect', result: '已发出' })
    const clerk = defineAgent({ id: 'clerk', instructions, capabilities: [tools([send])] })
    const lead = defineAgent({ id: 'lead', instructions, capabilities: [subagent(clerk)] })
    const model = fakeModel({
      model: 'main',
      replies: [
        {
          toolCalls: [
            { id: 'd1', name: 'delegate', input: { agent: 'clerk', task: '发函给星河科技' } },
          ],
        },
        { toolCalls: [{ id: 'k1', name: 'send', input: { to: '星河科技' } }] },
        { text: '函已发出' },
        { text: '已安排发函' },
        { text: '不用再发' },
      ],
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        logger: quiet,
      },
    })
    const env = engine.environment({ name: 'chat', principal: { reachable: true } })
    expect(await env.start(lead, ask('发律师函'), { session: 's' }).result).toMatchObject({
      status: 'completed',
    })
    const next = env.start(lead, ask('还要发吗'), { session: 's' })
    await next.result
    const started = (await read(archive, next.runId)).find((e) => e.t === 'run_started')
    expect(started?.t === 'run_started' && started.session?.window.ledger).toEqual([
      { turn: 1, tool: 'send', input: '{"to":"星河科技"}', status: 'executed' },
    ])
    expect(await sessionLogIssues(archive, 's')).toEqual([])
  })

  it('AC-019 carries the image of a tool result into the next turn', async () => {
    const png = new Uint8Array([137, 80, 78, 71])
    const shot = fakeTool({
      name: 'screenshot',
      effect: 'none',
      result: toolContent([
        { type: 'text', text: '页面截图' },
        { type: 'image', image: png, mediaType: 'image/png' },
      ]),
    })
    const model = fakeModel({
      model: 'main',
      replies: [
        { toolCalls: [{ id: 'p1', name: 'screenshot', input: {} }] },
        { text: '页面正常' },
        { text: '和上次一样' },
      ],
      capabilities: { contextLimit: 100_000, maxOutputTokens: 1_000, inputs: ['image'] },
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        logger: quiet,
      },
    })
    const env = engine.environment({ name: 'chat', principal: { reachable: true } })
    const agent = defineAgent({ id: 'helper', instructions, capabilities: [tools([shot])] })
    await env.start(agent, ask('截个图'), { session: 's' }).result
    const next = env.start(agent, ask('再看看'), { session: 's' })
    expect(await next.result).toMatchObject({ status: 'completed' })
    const base64 = Buffer.from(png).toString('base64')
    const carried = model.inputs[2]!.messages.flatMap((m) =>
      m.role === 'tool' ? m.content.flatMap((r) => r.images ?? []) : [],
    )
    expect(carried).toEqual([{ type: 'image', image: base64, mediaType: 'image/png' }])
    expect(await sessionLogIssues(archive, 's')).toEqual([])
  })
})
