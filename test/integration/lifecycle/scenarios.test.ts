// 端到端场景（设计 §12.3、§3.12）：交互（提问后带上运行记录接着对话）、后台（委托人联系不上时的收尾与兜底）、
// 中断后接着做（补齐结尾 → 复盘说明 + 运行记录 → 新运行）。

import { describe, expect, it } from 'vitest'
import {
  completionReview,
  createEngine,
  defineAgent,
  defineTask,
  foldState,
  intents,
  memoryArchive,
  modelHub,
  retrospect,
  retrospective,
  riskApproval,
  tools,
  transcriptMessages,
  type ArchiveStore,
  type BlobRef,
  type Guard,
  type ModelMessage,
  type RunEvent,
} from '../../../src/index.js'
import {
  FakeClock,
  assertInvariants,
  fakeModel,
  fakeTool,
  runToEnd,
  type FakeReply,
} from '../../../src/testing.js'

const quiet = { log: () => {} }
const userText = (text: string) => ({
  role: 'user' as const,
  parts: [{ type: 'text' as const, text }],
})

async function readAll(archive: ArchiveStore, runId: string): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}

/** 上次运行的运行记录投影成消息：运行记录只引用 blob，正文从档案读出。 */
async function transcriptOf(archive: ArchiveStore, runId: string): Promise<ModelMessage[]> {
  const { transcript } = foldState(await readAll(archive, runId))
  const refs: BlobRef[] = transcript.flatMap((e) =>
    e.origin === 'tool' ? e.results.map((r) => r.shown) : e.origin === 'hook' ? [e.content] : [],
  )
  const blobs = new Map<BlobRef, string>()
  const decoder = new TextDecoder()
  for (const ref of refs) {
    const data = await archive.getBlob(ref)
    blobs.set(ref, typeof data === 'string' ? data : decoder.decode(data))
  }
  return transcriptMessages(transcript, blobs)
}

function engineWith(
  replies: FakeReply[],
  archive: ArchiveStore = memoryArchive(),
  clock?: FakeClock,
) {
  const model = fakeModel({ model: 'main', replies, ...(clock ? { clock } : {}) })
  const engine = createEngine({
    services: {
      models: modelHub({ providers: [model], default: model.ref, ...(clock ? { clock } : {}) }),
      archive,
      logger: quiet,
      ...(clock ? { clock } : {}),
    },
  })
  return { engine, model, archive }
}

const toolNames = (events: readonly RunEvent[]) => {
  const started = events[0]
  return started?.t === 'run_started'
    ? started.capabilities.flatMap((c) => c.tools.map((t) => t.name))
    : []
}

describe('scenarios', () => {
  it('AC-015 interactive: asks the principal, then continues with the transcript and the reply', async () => {
    const lookup = fakeTool({ name: 'lookup', result: '东京 4 月 3 日有 2 个航班' })
    const book = fakeTool({
      name: 'book',
      risk: 'high',
      effect: 'side_effect',
      result: '已预留座位',
    })
    const agent = defineAgent({
      id: 'travel',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是出行助手' }] }],
      capabilities: [intents(), tools([lookup, book])],
    })
    const approvals: string[] = []
    const h = engineWith([
      { toolCalls: [{ id: 'b1', name: 'book', input: { flight: 'NH1' } }] },
      { toolCalls: [{ id: 'q1', name: 'ask_user', input: { question: '要靠窗还是靠过道？' } }] },
      { text: '已订 NH1 靠窗座位' },
    ])
    const env = h.engine.environment({
      name: 'interactive',
      principal: {
        reachable: true,
        approver: {
          approve: async (req) => {
            approvals.push(req.toolName)
            return { approved: true }
          },
        },
      },
      permissions: [riskApproval({ mode: 'ask-high' })],
    })

    const first = env.start(
      agent,
      defineTask({ input: [userText('帮我订 4 月 3 日去东京的机票')] }),
    )
    const asked = await runToEnd(first)
    assertInvariants(asked.events)
    // 模型只调用了 ask_user、没写正文：问题本身就是给委托人的答复。
    expect(asked.result).toMatchObject({
      status: 'awaiting_input',
      code: 'ask_user',
      text: '要靠窗还是靠过道？',
      intent: { tool: 'ask_user', input: { question: '要靠窗还是靠过道？' } },
    })
    expect(approvals).toEqual(['book'])
    expect(book.calls).toHaveLength(1)
    expect(toolNames(asked.events)).toEqual(
      expect.arrayContaining(['ask_user', 'propose', 'lookup', 'book']),
    )

    const history: ModelMessage[] = [
      { role: 'user', content: '帮我订 4 月 3 日去东京的机票' },
      ...(await transcriptOf(h.archive, first.runId)),
    ]
    const second = await runToEnd(
      env.start(agent, defineTask({ input: [userText('靠窗')], history })),
    )
    assertInvariants(second.events)
    expect(second.result).toMatchObject({ status: 'completed', text: '已订 NH1 靠窗座位' })
    const seen = h.model.inputs[2]!.messages
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: [expect.objectContaining({ toolCallId: 'q1' })],
        }),
        { role: 'user', content: [{ type: 'text', text: '靠窗' }] },
      ]),
    )
  })

  it('AC-016 background: excludes the principal tools and reports through the unreachable fallback', async () => {
    // 第 1 步告知、第 2 步收尾（先告知后终止）。
    const stall: Guard = {
      id: 'stall',
      version: '1',
      start: () => ({
        check: (facts) =>
          facts.step === 1
            ? { warn: { problem: '数据源没有更新' } }
            : { end: { as: 'finalize', code: 'stall' } },
      }),
    }
    const lookup = fakeTool({ name: 'lookup', result: '没有新数据' })
    const agent = defineAgent({
      id: 'reporter',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你负责生成日报' }] }],
      capabilities: [intents(), tools([lookup])],
    })
    const h = engineWith([
      { toolCalls: [{ id: 'l1', name: 'lookup', input: { day: 'today' } }] },
      { toolCalls: [{ id: 'l2', name: 'lookup', input: { day: 'yesterday' } }] },
      { text: '今日数据源没有更新，日报未生成；已查询 1 次数据源，未执行写操作。' },
    ])
    const run = h.engine
      .environment({ name: 'background', principal: { reachable: false } })
      .start(agent, defineTask({ input: [userText('生成今天的日报')], guards: [stall] }))
    const { result, events } = await runToEnd(run)
    assertInvariants(events)

    expect(result).toMatchObject({
      status: 'finalized',
      code: 'stall',
      text: '今日数据源没有更新，日报未生成；已查询 1 次数据源，未执行写操作。',
    })
    const names = toolNames(events)
    expect(names).toEqual(expect.arrayContaining(['report_blocked', 'lookup']))
    expect(names).not.toContain('finish')
    expect(names).not.toContain('ask_user')
    expect(names).not.toContain('propose')
    expect(h.model.inputs[0]!.tools.map((t) => t.name)).not.toContain('ask_user')
    // 联系不上的版本只报告进展、卡点和已执行的操作，不向委托人提问（设计 §3.11）。
    const request = JSON.stringify(h.model.inputs[2]!.messages.at(-1))
    expect(request).toContain(
      '连续多步没有获得新信息。请报告已经完成的部分、卡点，以及已执行的操作。',
    )
    expect(request).not.toContain('以问号结尾')
    expect(events.find((e) => e.t === 'fallback_generated')).toMatchObject({ code: 'stall' })
  })

  it('background: a reply that asks the unreachable principal is returned, and the run reports the block', async () => {
    const flights = fakeTool({ name: 'flight_search', result: '[]' })
    const agent = defineAgent({
      id: 'booker',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你负责订机票' }] }],
      capabilities: [intents(), tools([flights])],
    })
    const h = engineWith([
      { text: '还需要几个信息：出发城市是哪里？到达城市是哪里？' },
      // 完成审查的模型判定。
      { text: '{"complete": false, "confidence": 0.9, "missing": ["出发城市和到达城市"]}' },
      {
        toolCalls: [
          { id: 'b1', name: 'report_blocked', input: { reason: '缺少出发城市和到达城市' } },
        ],
      },
    ])
    const run = h.engine
      .environment({
        name: 'background',
        principal: { reachable: false },
        checks: [completionReview()],
      })
      .start(agent, defineTask({ input: [userText('帮我订一张明天的机票')] }))
    const { result, events } = await runToEnd(run)
    assertInvariants(events)

    expect(result).toMatchObject({ status: 'stopped', code: 'blocked' })
    expect(events.find((e) => e.t === 'delivery_checked')).toMatchObject({
      outcome: 'returned',
      checks: [expect.objectContaining({ source: 'check:completion', pass: false })],
    })
    const hint = JSON.stringify(h.model.inputs[2]!.messages)
    expect(hint).toContain('用 report_blocked 说明缺什么')
  })

  it('AC-017 resume: closes the interrupted run and continues from the brief and the transcript', async () => {
    const archive = memoryArchive()
    const clock = new FakeClock()
    const stuck = fakeTool({
      name: 'write',
      effect: 'side_effect',
      run: () => new Promise(() => {}),
    })
    const agentWith = (write: ReturnType<typeof fakeTool>) =>
      defineAgent({
        id: 'writer',
        instructions: [{ role: 'system', parts: [{ type: 'text', text: '你负责写日报' }] }],
        capabilities: [tools([write])],
      })
    const input = userText('把今天的日报写入 日报.md')

    // 第一个进程：跑到副作用工具时停住，之后不再推进，相当于进程退出。
    const before = engineWith(
      [{ toolCalls: [{ id: 'w1', name: 'write', input: { path: '日报.md' } }] }],
      archive,
      clock,
    )
    const crashed = before.engine
      .environment({ name: 'background', principal: { reachable: false } })
      .start(agentWith(stuck), defineTask({ input: [input] }))
    for (let i = 0; i < 20 && stuck.calls.length === 0; i++) await clock.tick(0)
    expect(stuck.calls).toHaveLength(1)

    // 第二个进程：启动时补齐中断运行的结尾。
    const after = engineWith([{ text: '已核实 日报.md 已写入，今天的日报完成。' }], archive)
    expect(await after.engine.interrupted()).toEqual([
      expect.objectContaining({ runId: crashed.runId, status: 'aborted', code: 'interrupted' }),
    ])
    const events = await readAll(archive, crashed.runId)
    expect(events.at(-1)).toMatchObject({ t: 'run_ended', result: { code: 'interrupted' } })
    assertInvariants(events)
    const brief = retrospect.brief(retrospective(events))
    expect(brief).toContain('write {"path":"日报.md"}（可能已执行）')

    const history: ModelMessage[] = [
      { role: 'user', content: '把今天的日报写入 日报.md' },
      ...(await transcriptOf(archive, crashed.runId)),
    ]
    const write = fakeTool({ name: 'write', effect: 'side_effect', result: '已写入' })
    const resumed = await runToEnd(
      after.engine
        .environment({ name: 'background', principal: { reachable: false } })
        .start(
          agentWith(write),
          defineTask({ input: [userText(brief), userText('继续')], history }),
        ),
    )
    assertInvariants(resumed.events)
    expect(resumed.result).toMatchObject({
      status: 'completed',
      text: '已核实 日报.md 已写入，今天的日报完成。',
    })
    expect(write.calls).toHaveLength(0)
    const seen = JSON.stringify(after.model.inputs[0]!.messages)
    expect(seen).toContain('TOOL_INTERRUPTED')
    expect(seen).toContain('（可能已执行）')
  })
})
