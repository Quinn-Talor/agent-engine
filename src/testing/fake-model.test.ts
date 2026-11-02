import { describe, expect, it } from 'vitest'
import { estimateMessages, estimateText, isAbortError, isModelCallError } from '../sdk.js'
import type { Delta, ModelInput } from '../contracts/model.js'
import { FakeClock } from './fake-clock.js'
import { fakeModel } from './fake-model.js'

const input: ModelInput = { messages: [{ role: 'user', content: 'hello there' }], tools: [] }
const call = (model: ReturnType<typeof fakeModel>, signal = new AbortController().signal) => {
  const deltas: Delta[] = []
  const promise = model.port.call(input, { signal, onDelta: (d) => deltas.push(d) })
  return { promise, deltas }
}

describe('fakeModel', () => {
  it('AC-013 replies from the script in order and records inputs', async () => {
    const model = fakeModel({
      replies: [
        { text: 'hello' },
        { toolCalls: [{ name: 'search', input: { q: 'x' } }] },
        { error: { code: 'RATE_LIMITED' } },
      ],
    })
    const first = call(model)
    expect(await first.promise).toMatchObject({
      text: 'hello',
      toolCalls: [],
      finishReason: 'stop',
      usage: { input: estimateMessages(input.messages), output: estimateText('hello') },
    })
    expect(first.deltas).toEqual([{ type: 'text', text: 'hello' }])

    expect(await call(model).promise).toMatchObject({
      text: '',
      toolCalls: [{ id: 'call-1-0', name: 'search', input: { q: 'x' } }],
      finishReason: 'tool-calls',
    })

    const error = await call(model).promise.catch((e: unknown) => e)
    expect(isModelCallError(error)).toBe(true)
    expect(error).toMatchObject({
      detail: { code: 'RATE_LIMITED', message: 'RATE_LIMITED', retryable: false },
    })
    expect(model.inputs).toHaveLength(3)
  })

  it('AC-014 hangs until the caller aborts', async () => {
    const model = fakeModel({ replies: [{ hang: true }] })
    const controller = new AbortController()
    const { promise } = call(model, controller.signal)
    controller.abort()
    await expect(promise).rejects.toSatisfy(isAbortError)
  })

  it('waits for the clock when a reply has a delay', async () => {
    const clock = new FakeClock()
    const model = fakeModel({ replies: [{ text: 'late', delayMs: 500 }], clock })
    let done = false
    const { promise } = call(model)
    void promise.then(() => (done = true))
    await clock.tick(499)
    expect(done).toBe(false)
    await clock.tick(1)
    expect(done).toBe(true)
  })

  it('aborts while waiting for a delay', async () => {
    const clock = new FakeClock()
    const model = fakeModel({ replies: [{ text: 'late', delayMs: 500 }], clock })
    const controller = new AbortController()
    const { promise } = call(model, controller.signal)
    controller.abort()
    await expect(promise).rejects.toSatisfy(isAbortError)
  })

  it('supports function replies, reasoning, explicit usage and repeatLast', async () => {
    const model = fakeModel({
      provider: 'p',
      model: 'm',
      repeatLast: true,
      capabilities: { contextLimit: 50 },
      replies: [
        (i) => ({
          text: `${i.messages.length} message`,
          reasoning: { text: 'think', providerData: { sig: 1 } },
          usage: { input: 7 },
          finishReason: 'length',
        }),
      ],
    })
    expect(model.ref).toBe('p:m')
    expect(model.resolve('p:m')).toBe(model.port)
    expect(model.resolve('p:x')).toBeUndefined()
    expect(model.port.capabilities.contextLimit).toBe(50)
    expect(model.port.capabilities.toolCalls).toBe(true)
    const first = call(model)
    expect(await first.promise).toMatchObject({
      text: '1 message',
      reasoning: { text: 'think', providerData: { sig: 1 } },
      usage: { input: 7, output: estimateText('1 message'), cacheRead: 0, cacheWrite: 0 },
      finishReason: 'length',
    })
    expect(first.deltas).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: '1 message' },
    ])
    expect((await call(model).promise).text).toBe('1 message')
  })

  it('fails when the script runs out', async () => {
    const model = fakeModel({ replies: [] })
    await expect(call(model).promise).rejects.toMatchObject({
      detail: { code: 'MODEL_ERROR', message: 'fake model script exhausted' },
    })
  })
})
