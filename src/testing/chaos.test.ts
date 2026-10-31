import { describe, expect, it } from 'vitest'
import {
  isAbortError,
  memoryArchive,
  modelHub,
  type HookExec,
  type HookExecResult,
  type ModelProvider,
  type ResolvedMcpServer,
} from '../api.js'
import type { Delta, ModelInput } from '../contracts/model.js'
import { chaos } from './chaos.js'
import { testHarness, twoSteps } from './engine.fixture.js'
import { FakeClock } from './fake-clock.js'
import { fakeMcpServer } from './fake-mcp-server.js'
import { fakeModel, type FakeReply } from './fake-model.js'

const server: ResolvedMcpServer = { name: 'docs', transport: { kind: 'stdio', command: 'docs' } }
const ok: HookExecResult = { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }

function recordingExec() {
  const commands: string[] = []
  const exec: HookExec = async (command) => {
    commands.push(command)
    return ok
  }
  return { exec, commands }
}

const input: ModelInput = { messages: [{ role: 'user', content: '东京天气' }], tools: [] }
const outcome = (p: Promise<unknown>) => {
  const state: { settled: boolean; error?: unknown } = { settled: false }
  p.then(
    () => (state.settled = true),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  )
  return state
}

/** 经模型库调用一次被注入超时的模型；模型库的计时器走 FakeClock。 */
function hungCall(
  reply: FakeReply,
  timeouts: { firstTokenMs?: number; idleMs?: number; totalMs?: number },
) {
  const clock = new FakeClock()
  const model = fakeModel({ model: 'main', replies: [reply] })
  const signals: AbortSignal[] = []
  const spy: ModelProvider = {
    id: model.id,
    resolve: (ref) => {
      const port = model.resolve(ref)
      return port && { ...port, call: (i, o) => (signals.push(o.signal), port.call(i, o)) }
    },
  }
  const c = chaos({ faults: ['model_timeout'], rate: 1 })
  const hub = modelHub({ providers: [c.provider(spy)], clock, timeouts })
  const controller = new AbortController()
  const deltas: Delta[] = []
  const promise = hub
    .resolve(model.ref)!
    .call(input, { signal: controller.signal, onDelta: (d) => deltas.push(d) })
  return { clock, controller, deltas, signals, state: outcome(promise), injected: c.injected }
}

describe('chaos', () => {
  it('AC-004 turns model calls into 503 errors and records the injection', async () => {
    const c = chaos({ faults: ['model_5xx'], rate: 1 })
    const h = testHarness({ replies: twoSteps, wrapProvider: (p) => c.provider(p) })
    const result = await h.start().result
    expect(result).toMatchObject({
      status: 'failed',
      code: 'model_error',
      error: { code: 'MODEL_ERROR', message: 'chaos: 503', retryable: true },
    })
    expect(c.injected[0]).toEqual({ fault: 'model_5xx', target: 'fake:main' })
    expect(h.model.inputs).toHaveLength(0)
  })

  it('AC-004 hangs model calls until the model hub times them out', async () => {
    const clock = new FakeClock()
    const c = chaos({ faults: ['model_timeout'], rate: 1 })
    const run = testHarness({
      replies: twoSteps,
      wrapProvider: (p) => c.provider(p),
      hub: { clock, timeouts: { firstTokenMs: 1_000 } },
    }).start()
    const state = outcome(run.result)
    while (clock.pending() === 0 && !state.settled) await new Promise((r) => setTimeout(r, 1))
    await clock.tick(999)
    expect(state.settled).toBe(false)
    await clock.tick(1)
    expect(await run.result).toMatchObject({
      status: 'failed',
      error: { code: 'MODEL_TIMEOUT', message: '首 token 超时' },
    })
    expect(c.injected[0]?.fault).toBe('model_timeout')
  })

  it('AC-004 stalls a streaming reply after its first delta until the idle timer fires', async () => {
    const h = hungCall({ text: '东京今天晴。' }, { firstTokenMs: 10_000, idleMs: 500 })
    await h.clock.tick(499)
    expect(h.deltas).toEqual([{ type: 'text', text: '东京今天晴。' }])
    expect(h.state.settled).toBe(false)
    await h.clock.tick(1)
    expect(h.state.error).toMatchObject({ detail: { code: 'MODEL_TIMEOUT', message: '空闲超时' } })
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.injected).toEqual([{ fault: 'model_timeout', target: 'fake:main' }])
  })

  it('AC-004 fails a hung model call on the total timer', async () => {
    const h = hungCall({ toolCalls: [{ name: 'lookup' }] }, { firstTokenMs: 10_000, totalMs: 300 })
    await h.clock.tick(299)
    expect(h.state.settled).toBe(false)
    await h.clock.tick(1)
    expect(h.state.error).toMatchObject({
      detail: { code: 'MODEL_TIMEOUT', message: '单次时长超时' },
    })
  })

  it('AC-004 releases a hung model call when the caller aborts', async () => {
    const h = hungCall({ text: '东京今天晴。' }, {})
    await h.clock.tick(1_000)
    expect(h.state.settled).toBe(false)
    h.controller.abort()
    await h.clock.tick(0)
    expect(isAbortError(h.state.error)).toBe(true)
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.clock.pending()).toBe(0)
  })

  it('AC-005 fails the run with engine_error when the archive cannot be written', async () => {
    const c = chaos({ faults: ['archive_write'], rate: 1 })
    const h = testHarness({ replies: twoSteps, wrapArchive: (a) => c.archive(a) })
    const run = h.start()
    const result = await run.result
    expect(result).toMatchObject({ runId: run.runId, status: 'failed', code: 'engine_error' })
    // 运行开始前先写任务内容的 blob，所以第一个注入点可能是 blob，也可能是事件追加。
    expect(c.injected.length).toBeGreaterThan(0)
    expect(c.injected.every((i) => i.fault === 'archive_write')).toBe(true)
    expect(c.injected.map((i) => i.target)).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^(blob|${run.runId})$`))]),
    )
  })

  it('AC-005 also fails blob writes', async () => {
    const c = chaos({ faults: ['archive_write'], rate: 1 })
    await expect(c.archive(memoryArchive()).putBlob('x')).rejects.toThrow('chaos: 存储写失败')
    expect(c.injected).toEqual([{ fault: 'archive_write', target: 'blob' }])
  })

  it('AC-005 passes the other archive operations through', async () => {
    const c = chaos({ faults: ['archive_write'], rate: 0 })
    const h = testHarness({ replies: twoSteps, wrapArchive: (a) => c.archive(a) })
    const run = h.start()
    expect(await run.result).toMatchObject({ status: 'completed' })
    const archive = c.archive(h.archive)
    const ref = await archive.putBlob('x')
    expect(await archive.getBlob(ref)).toBe('x')
    expect(await archive.query({ rootRunId: run.runId })).toHaveLength(1)
    await archive.pin(run.runId, 'keep')
    expect(await archive.retain({ defaultDays: 30, now: 0 })).toBeDefined()
    const seqs: number[] = []
    for await (const e of archive.read(run.runId, 2)) seqs.push(e.seq)
    expect(seqs[0]).toBe(2)
  })

  it('AC-006 disconnects MCP connections in the middle of a call', async () => {
    const fake = fakeMcpServer({ tools: [{ name: 'search', handler: () => '结果' }] })
    const c = chaos({ faults: ['mcp_disconnect'], rate: 1 })
    const conn = await c.mcpConnect(fake.connect)(server, { signal: new AbortController().signal })
    let closed = 0
    conn.onClose(() => void closed++)
    const opts = { signal: new AbortController().signal, timeoutMs: 1000 }
    await expect(conn.callTool('search', {}, opts)).rejects.toThrow('chaos: MCP 断连')
    expect(closed).toBe(1)
    expect(fake.calls).toHaveLength(0)
    expect(c.injected).toEqual([{ fault: 'mcp_disconnect', target: 'docs/search' }])
    expect(await conn.listTools()).toEqual([expect.objectContaining({ name: 'search' })])
  })

  it('AC-006 passes MCP calls and changes through when nothing is injected', async () => {
    const fake = fakeMcpServer({ tools: [{ name: 'search', handler: () => '结果' }] })
    const conn = await chaos({ rate: 0 }).mcpConnect(fake.connect)(server, {
      signal: new AbortController().signal,
    })
    let changed = 0
    let closed = 0
    conn.onToolsChanged(() => void changed++)
    conn.onClose(() => void closed++)
    const opts = { signal: new AbortController().signal, timeoutMs: 1000 }
    expect(await conn.callTool('search', {}, opts)).toEqual({
      content: [{ type: 'text', text: '结果' }],
    })
    fake.setTools([{ name: 'other' }])
    fake.disconnect()
    expect([changed, closed]).toEqual([1, 1])
    await conn.close()
  })

  it('AC-006 hangs hooks until their timeout fires on the clock, without running them', async () => {
    const clock = new FakeClock()
    const { exec, commands } = recordingExec()
    const c = chaos({ faults: ['hook_timeout'], rate: 1, clock })
    const pending = c.hookExec(exec)('lint.sh', '{}', { timeoutMs: 100 })
    const state = outcome(pending)
    await clock.tick(99)
    expect(state.settled).toBe(false)
    await clock.tick(1)
    expect(await pending).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: true })
    expect(commands).toEqual([])
    expect(c.injected).toEqual([{ fault: 'hook_timeout', target: 'lint.sh' }])
  })

  it('AC-006 rejects a hung hook when the caller aborts', async () => {
    const clock = new FakeClock()
    const { exec } = recordingExec()
    const c = chaos({ faults: ['hook_timeout'], rate: 1, clock })
    const controller = new AbortController()
    const pending = c.hookExec(exec)('lint.sh', '{}', {
      timeoutMs: 100,
      signal: controller.signal,
    })
    const state = outcome(pending)
    await clock.tick(50)
    expect(state.settled).toBe(false)
    controller.abort()
    await clock.tick(0)
    expect(isAbortError(state.error)).toBe(true)
    expect(clock.pending()).toBe(0)
  })

  it('AC-007 repeats the same injections for the same seed', async () => {
    const pattern = async (seed: number) => {
      const { exec } = recordingExec()
      const c = chaos({ seed, rate: 0.5, faults: ['hook_timeout'] })
      const wrapped = c.hookExec(exec)
      const out: boolean[] = []
      for (let i = 0; i < 20; i++) out.push((await wrapped('h', '', { timeoutMs: 1 })).timedOut)
      return { out, injected: c.injected.length }
    }
    const a = await pattern(3)
    expect(await pattern(3)).toEqual(a)
    expect(a.injected).toBeGreaterThan(0)
    expect(a.injected).toBeLessThan(20)
    expect((await pattern(4)).out).not.toEqual(a.out)
  })

  it('AC-007 injects nothing at rate 0 or for faults that are not listed', async () => {
    const { exec, commands } = recordingExec()
    const none = chaos({ rate: 0 })
    expect(await none.hookExec(exec)('a', '', { timeoutMs: 1 })).toEqual(ok)
    const other = chaos({ rate: 1, faults: ['model_5xx'] })
    expect(await other.hookExec(exec)('b', '', { timeoutMs: 1 })).toEqual(ok)
    expect(commands).toEqual(['a', 'b'])
    expect([none.injected, other.injected]).toEqual([[], []])
    const h = testHarness({ replies: twoSteps, wrapProvider: (p) => other.provider(p) })
    expect(other.provider(h.model).resolve('fake:other')).toBeUndefined()
  })
})
