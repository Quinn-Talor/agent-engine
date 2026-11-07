import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../contracts/common.js'
import type { Check, Memory } from '../contracts/component.js'
import type { RunEvent } from '../contracts/events.js'
import type { ModelCapabilities, ModelInput } from '../contracts/model.js'
import type { Run } from '../contracts/run.js'
import { canonicalJson, parseCanonical, sha256Hex } from '../core/definition/hash.js'
import { regressionReplay } from './replay.js'
import { summaryMessage } from '../core/run/layout.js'
import { memoryArchive } from '../services/memory-archive.js'
import { sessionLogIssues } from '../services/session-log.js'
import { FakeClock } from '../testing/fake-clock.js'
import { fakeModel, type FakeReply } from '../testing/fake-model.js'
import { fakeTool } from '../testing/fake-tool.js'
import { assembleEngine } from './engine.js'
import {
  agentOf,
  defaults,
  fixedFallback,
  hubOf,
  passMemory,
  taskOf,
  textOutput,
} from './engine.fixture.js'

const send = fakeTool({ name: 'send', effect: 'side_effect', result: '已发出' })
const agent = agentOf({
  capabilities: [
    {
      id: 'core',
      version: '1',
      kind: 'tool',
      prepare: async () => ({ tools: [send], snapshot: { fingerprint: 'fp' } }),
    },
  ],
})
const ask = (text: string) => taskOf({ input: [{ role: 'user', parts: [{ type: 'text', text }] }] })

/** 会话里一轮的 run_started（只有开头，没有结束）。 */
const openTurn = (runId: string, session: string): Omit<RunEvent, 'seq' | 'at'> =>
  ({
    t: 'run_started',
    agent: { id: 'helper', fingerprint: 'fp' },
    task: { fingerprint: 'fp', content: `sha256:${'0'.repeat(64)}` },
    environment: { name: 'chat', fingerprint: 'fp', principalReachable: true },
    engine: { fingerprint: 'fp' },
    capabilities: [],
    unavailable: [],
    model: 'fake:main',
    contextLimit: 128_000,
    outputReserve: 8192,
    queuedMs: 0,
    rootRunId: runId,
    schemaVersion: 1,
    session: {
      id: session,
      turn: 1,
      window: { version: 1, turnStarts: [], ledger: [], tokens: 0 },
    },
  }) as Omit<RunEvent, 'seq' | 'at'>

function setup(
  replies: FakeReply[],
  memory: Memory = passMemory(),
  capabilities: Partial<ModelCapabilities> = {},
) {
  const clock = new FakeClock()
  const model = fakeModel({ model: 'main', clock, replies, capabilities })
  const archive = memoryArchive()
  const engine = assembleEngine(
    { services: { models: hubOf([model.port], { defaultModel: 'fake:main' }), clock, archive } },
    { ...defaults(), memory, guards: [], logger: { log: () => {} } },
  )
  const env = engine.environment({ name: 'chat', principal: { reachable: true } })
  const read = async (runId: string) => {
    const out: RunEvent[] = []
    for await (const e of archive.read(runId)) out.push(e)
    return out
  }
  const started = async (runId: string) =>
    (await read(runId)).find(
      (e): e is Extract<RunEvent, { t: 'run_started' }> => e.t === 'run_started',
    )!
  return { clock, model, archive, engine, env, read, started }
}

/** 模型这一次看到的、任务输入之前的消息里有没有这段文字。 */
const sees = (input: ModelInput | undefined, text: string) =>
  JSON.stringify(input?.messages ?? []).includes(text)

describe('sessions', () => {
  it('§6 carries the previous turn into the next and records the chain', async () => {
    const h = setup([{ text: '答一' }, { text: '答二' }])
    const first = h.env.start(agent, ask('问题一'), { session: 'case-1' })
    await first.result
    const second = h.env.start(agent, ask('问题二'), { session: 'case-1' })
    expect(await second.result).toMatchObject({ status: 'completed', text: '答二' })

    const messages = h.model.inputs[1]!.messages
    const at = (text: string) => messages.findIndex((m) => JSON.stringify(m).includes(text))
    expect(at('问题一')).toBeGreaterThan(-1)
    expect(at('答一')).toBeGreaterThan(at('问题一'))
    expect(at('问题二')).toBeGreaterThan(at('答一'))

    const s2 = await h.started(second.runId)
    expect(s2.session).toMatchObject({
      id: 'case-1',
      turn: 2,
      continues: { runId: first.runId },
      window: { version: 1, turnStarts: [0], ledger: [] },
    })
    expect(s2.task.subject).toBe('case-1')
    const turns = await h.archive.query({ session: 'case-1' })
    expect(turns.map((t) => [t.turn, t.continues ?? null]).sort()).toEqual([
      [1, null],
      [2, first.runId],
    ])
    expect(await sessionLogIssues(h.archive, 'case-1')).toEqual([])
  })

  it('§4 refuses a session turn that also gives a history', async () => {
    const h = setup([])
    const run = h.env.start(agent, taskOf({ history: [{ role: 'user', content: '早先的话' }] }), {
      session: 'case-1',
    })
    expect(await run.result).toMatchObject({ status: 'failed', code: 'invalid_task' })
    expect((await h.archive.query({ session: 'case-1' }))[0]).toMatchObject({
      session: 'case-1',
      status: 'failed',
    })
    expect((await h.archive.query({ session: 'case-1' }))[0]).not.toHaveProperty('turn')
  })

  it('§12 refuses a second turn while one is running, and lets it through afterwards', async () => {
    const h = setup([{ hang: true }, { text: '答' }, { text: '答' }])
    const first = h.env.start(agent, ask('一'), { session: 'case-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = h.env.start(agent, ask('二'), { session: 'case-1' })
    expect(await second.result).toMatchObject({
      status: 'failed',
      code: 'session_busy',
      error: { retryable: true },
    })
    first.abort()
    await first.result
    const third = h.env.start(agent, ask('三'), { session: 'case-1' })
    expect(await third.result).toMatchObject({ status: 'completed' })
    expect((await h.started(third.runId)).session?.turn).toBe(2)
    // 别的会话不受影响。
    expect(await h.env.start(agent, ask('四'), { session: 'case-2' }).result).toMatchObject({
      status: 'completed',
    })
  })

  it('§12 forks from an earlier turn, and starts over with null', async () => {
    const h = setup([{ text: '答一' }, { text: '答二' }, { text: '答三' }, { text: '答四' }])
    const t1 = h.env.start(agent, ask('问一'), { session: 's' })
    await t1.result
    await h.env.start(agent, ask('问二'), { session: 's' }).result
    const fork = h.env.start(agent, ask('问三'), { session: 's', continues: t1.runId })
    await fork.result
    expect(sees(h.model.inputs[2], '问一')).toBe(true)
    expect(sees(h.model.inputs[2], '问二')).toBe(false)
    const fresh = h.env.start(agent, ask('问四'), { session: 's', continues: null })
    await fresh.result
    expect(sees(h.model.inputs[3], '问一')).toBe(false)
    expect((await h.started(fresh.runId)).session).toMatchObject({ turn: 4 })
    expect((await h.started(fresh.runId)).session).not.toHaveProperty('continues')
    expect(await sessionLogIssues(h.archive, 's')).toEqual([])
  })

  it('§4 refuses a continuation point outside the session', async () => {
    const h = setup([{ text: '答' }])
    const other = h.env.start(agent, ask('一'), { session: 'other' })
    await other.result
    const run = h.env.start(agent, ask('二'), { session: 's', continues: other.runId })
    expect(await run.result).toMatchObject({ status: 'failed', code: 'invalid_task' })
    const orphan = h.env.start(agent, ask('三'), { continues: other.runId })
    expect(await orphan.result).toMatchObject({ status: 'failed', code: 'invalid_task' })
  })

  it('§9 shows the side effects of every branch in the tail', async () => {
    const h = setup([
      { toolCalls: [{ id: 'c1', name: 'send', input: { to: '星河科技' } }] },
      { text: '已发函' },
      { text: '重新开始' },
    ])
    const t1 = h.env.start(agent, ask('发律师函'), { session: 's' })
    await t1.result
    const fork = h.env.start(agent, ask('从头说'), { session: 's', continues: null })
    await fork.result
    const tail = h.model.inputs[2]!.messages.at(-1)!
    expect(JSON.stringify(tail)).toContain('第 1 轮 send {\\"to\\":\\"星河科技\\"}')
    expect((await h.started(fork.runId)).session?.window.ledger).toEqual([
      { turn: 1, tool: 'send', input: '{"to":"星河科技"}', status: 'executed' },
    ])
    expect(await sessionLogIssues(h.archive, 's')).toEqual([])
  })

  it('§6 carries a steer that arrived after the last context, and refuses one after the end', async () => {
    // 验收时才到的引导：本轮已经没有下一步，由 carry 带进下一轮。
    const lateSteer: Check = {
      id: 'late-steer',
      version: '1',
      mode: 'gate',
      start: () => ({
        accept: async () => {
          first.steer('再算一下加班费')
          return { pass: true }
        },
      }),
    }
    const h = setup([{ text: '补偿 54000 元' }, { text: '加班费另算' }])
    const task = taskOf({
      input: [{ role: 'user', parts: [{ type: 'text', text: '算补偿' }] }],
      deliverable: { output: textOutput(), checks: [lateSteer], fallback: fixedFallback() },
    })
    const first: Run = h.env.start(agent, task, { session: 's' })
    expect(await first.result).toMatchObject({ status: 'completed', text: '补偿 54000 元' })
    expect(first.steer('太晚了')).toBe(false)
    await h.env.start(agent, ask('还有吗'), { session: 's' }).result
    const messages = h.model.inputs[1]!.messages
    const at = (text: string) => messages.findIndex((m) => JSON.stringify(m).includes(text))
    expect(at('再算一下加班费')).toBeGreaterThan(at('补偿 54000 元'))
    expect(at('还有吗')).toBeGreaterThan(at('再算一下加班费'))
    expect(sees(h.model.inputs[1], '太晚了')).toBe(false)
    expect(await sessionLogIssues(h.archive, 's')).toEqual([])
  })

  it('§6 applies the compaction of the previous turn and merges into its summary', async () => {
    // 第 1 步把前文（上一轮的窗口）全部换成摘要。
    const seen: Array<{ summary?: string; turnStarts?: number[] }> = []
    const memory: Memory = {
      id: 'fold-history',
      version: '1',
      start: () => ({
        recall: async (s) => {
          if (s.step === 1) seen.push({ summary: s.summary, turnStarts: s.turnStarts })
          return s.history.length > 0
            ? { compaction: { upTo: s.history.length, summary: `摘要${seen.length}` } }
            : {}
        },
      }),
    }
    const h = setup([{ text: '答一' }, { text: '答二' }, { text: '答三' }], memory)
    await h.env.start(agent, ask('问一'), { session: 's' }).result
    await h.env.start(agent, ask('问二'), { session: 's' }).result
    const third = h.env.start(agent, ask('问三'), { session: 's' })
    await third.result
    // 第 3 轮带入：第 2 轮的摘要 + 第 2 轮的输入与答复。
    const s3 = await h.started(third.runId)
    const content = JSON.parse((await h.archive.getBlob(s3.task.content!)) as string) as {
      history: ModelMessage[]
    }
    expect(content.history[0]).toEqual(summaryMessage('摘要2'))
    expect(JSON.stringify(content.history)).toContain('问二')
    expect(JSON.stringify(content.history)).not.toContain('问一')
    expect(seen.at(-1)).toEqual({ summary: '摘要2', turnStarts: [1] })
    expect(await sessionLogIssues(h.archive, 's')).toEqual([])
  })

  it('AC-018 previews exactly the window the next turn freezes, and refuses while a turn runs', async () => {
    const h = setup([{ text: '答一' }, { text: '答二' }, { hang: true }])
    const first = h.env.start(agent, ask('问一'), { session: 's' })
    await first.result
    const preview = await h.engine.previewWindow({ session: 's' })
    expect(preview).toMatchObject({ ok: true, turn: 2, continues: first.runId, ledger: [] })
    expect(h.model.inputs).toHaveLength(1)
    const second = h.env.start(agent, ask('问二'), { session: 's' })
    await second.result
    const frozen = await h.started(second.runId)
    const content = JSON.parse((await h.archive.getBlob(frozen.task.content)) as string) as {
      history: ModelMessage[]
    }
    expect(preview.ok && canonicalJson(preview.messages)).toBe(canonicalJson(content.history))
    expect(await h.engine.previewWindow({ session: 'empty' })).toMatchObject({
      ok: true,
      turn: 1,
      messages: [],
    })
    expect(await h.engine.previewWindow({ session: 's', continues: 'nope' })).toMatchObject({
      ok: false,
      code: 'invalid_task',
    })
    const running = h.env.start(agent, ask('问三'), { session: 's' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await h.engine.previewWindow({ session: 's' })).toMatchObject({
      ok: false,
      code: 'session_busy',
    })
    running.abort()
    await running.result
  })

  it('AC-004 deletes a whole session, but not while a turn is running', async () => {
    const h = setup([{ text: '答一' }, { hang: true }, { text: '答三' }])
    const first = h.env.start(agent, ask('问一'), { session: 's' })
    await first.result
    await h.archive.pin(first.runId, '重要')
    const running = h.env.start(agent, ask('问二'), { session: 's' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await h.engine.deleteSession('s')).toMatchObject({ ok: false, code: 'session_busy' })
    running.abort()
    await running.result
    // 固定的运行一并删除：显式删除优先于固定。
    expect(await h.engine.deleteSession('s')).toMatchObject({ ok: true, removedRuns: 2 })
    expect(await h.archive.query({ session: 's' })).toEqual([])
  })

  it('AC-004 answers session_open when the archive still has an unfinished run', async () => {
    const h = setup([])
    // 上一轮的 run_ended 没有写进档案（存储失败）：档案里这一轮没有结束。
    await h.archive.append('stuck', [{ ...openTurn('stuck', 's'), seq: 1, at: 1_000 } as RunEvent])
    expect(await h.engine.deleteSession('s')).toMatchObject({ ok: false, code: 'session_open' })
  })

  it('AC-004 refuses a new turn while the session is being deleted', async () => {
    const h = setup([{ text: '答一' }, { text: '答二' }])
    await h.env.start(agent, ask('问一'), { session: 's' }).result
    const deleting = h.engine.deleteSession('s')
    const during = h.env.start(agent, ask('问二'), { session: 's' })
    expect(await during.result).toMatchObject({ status: 'failed', code: 'session_busy' })
    expect(await deleting).toMatchObject({ ok: true })
  })

  it('AC-010 carries a binary attachment byte for byte across turns', async () => {
    const h = setup(
      [{ text: '看到了' }, { text: '还是那张图' }, { text: '同一张' }],
      passMemory(),
      { inputs: ['image'] },
    )
    const image = new Uint8Array([137, 80, 78, 71])
    const picture = taskOf({
      input: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: '看这张图' },
            { type: 'image', image, mediaType: 'image/png' },
          ],
        },
      ],
    })
    await h.env.start(agent, picture, { session: 's' }).result
    await h.env.start(agent, ask('再看看'), { session: 's' }).result
    const third = h.env.start(agent, ask('还记得吗'), { session: 's' })
    await third.result
    for (const input of h.model.inputs.slice(1)) {
      const part = input.messages
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
        .find((p) => p.type === 'image') as { image: unknown } | undefined
      expect(part?.image).toEqual(image)
    }
    expect(await sessionLogIssues(h.archive, 's')).toEqual([])
    const events = await h.read(third.runId)
    const report = await regressionReplay({
      events,
      getBlob: async (ref) => (await h.archive.getBlob(ref)) as string,
      guards: { task: [], environment: [], capability: [], engine: [] },
      deliverable: defaults().deliverable,
    })
    expect(report.deliveries.every((d) => d.same)).toBe(true)
    const started = await h.started(third.runId)
    const content = parseCanonical((await h.archive.getBlob(started.task.content)) as string)
    expect(JSON.stringify(content)).not.toContain('$bytes')
  })

  it('AC-012 stores an image once however many turns carry it', async () => {
    const h = setup([{ text: '看到了' }, { text: '又看到了' }], passMemory(), {
      inputs: ['image'],
    })
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const withImage = (text: string) =>
      taskOf({
        input: [
          {
            role: 'user',
            parts: [
              { type: 'text', text },
              { type: 'image', image: png, mediaType: 'image/png' },
            ],
          },
        ],
      })
    const first = h.env.start(agent, withImage('看这张图'), { session: 's' })
    await first.result
    const second = h.env.start(agent, withImage('还是这张'), { session: 's' })
    await second.result
    const ref = `sha256:${sha256Hex(png)}`
    for (const runId of [first.runId, second.runId]) {
      const started = await h.started(runId)
      expect(started.task.media).toEqual([ref])
      expect(await h.archive.getBlob(started.task.content)).not.toContain(png)
    }
    expect(await h.archive.getBlob(ref)).toBe(png)
    const images = h.model.inputs[1]!.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; image?: unknown }>).filter((p) => p.type === 'image')
        : [],
    )
    expect(images.map((p) => p.image)).toEqual([png, png])
    expect(await sessionLogIssues(h.archive, 's')).toEqual([])
  })

  it('AC-011 refuses a steer on a turn that the busy session turns away', async () => {
    const h = setup([{ hang: true }])
    const first = h.env.start(agent, ask('一'), { session: 's' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = h.env.start(agent, ask('二'), { session: 's' })
    expect(second.steer('别忘了加班费')).toBe(false)
    expect(await second.result).toMatchObject({ code: 'session_busy' })
    expect((await h.read(second.runId)).map((e) => e.t)).toEqual(['run_ended'])
    first.abort()
    await first.result
  })

  it('AC-011 drops steers queued before a run that never starts', async () => {
    const h = setup([])
    const run = h.env.start(agent, taskOf({ history: [{ role: 'user', content: '早' }] }), {
      session: 's',
    })
    run.steer('排在受理之前的引导')
    await run.result
    expect((await h.read(run.runId)).map((e) => e.t)).toEqual(['run_ended'])
  })

  it('AC-012 gives tools the session id as the default subject', async () => {
    const lookup = fakeTool({ name: 'lookup', result: 'ok' })
    const withLookup = agentOf({
      capabilities: [
        {
          id: 'core',
          version: '1',
          kind: 'tool',
          prepare: async () => ({ tools: [lookup], snapshot: { fingerprint: 'fp' } }),
        },
      ],
    })
    const h = setup([{ toolCalls: [{ id: 'c1', name: 'lookup', input: {} }] }, { text: '好' }])
    await h.env.start(withLookup, ask('查一下'), { session: 'case-9' }).result
    expect(lookup.calls[0]!.ctx.task.subject).toBe('case-9')
  })
})
