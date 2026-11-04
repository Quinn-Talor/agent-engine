import { describe, expect, it } from 'vitest'
import { ModelCallError, abortError, isAbortError } from '../contracts/errors.js'
import type {
  Delta,
  ModelCapabilities,
  ModelError,
  ModelInput,
  ModelPort,
  ModelResponse,
} from '../contracts/model.js'
import { FakeClock } from '../testing/fake-clock.js'
import { modelHub, type ModelHubOptions } from './model-hub.js'

const caps: ModelCapabilities = {
  contextLimit: 1000,
  maxOutputTokens: 100,
  vision: false,
  toolCalls: true,
  reasoning: 'none',
  systemAfterUser: true,
  parallelToolCalls: true,
}
const input: ModelInput = { messages: [], tools: [] }
const response: ModelResponse = {
  text: 'ok',
  toolCalls: [],
  finishReason: 'stop',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  warnings: [],
  attempts: [],
}

interface Pending {
  signal: AbortSignal
  onDelta: (d: Delta) => void
  resolve: (r: ModelResponse) => void
  reject: (e: unknown) => void
}

/** 由测试手动结束每次调用的端口。 */
function controllablePort(ref = 'fake:m') {
  const pending: Pending[] = []
  const port: ModelPort = {
    ref,
    capabilities: caps,
    call: (_input, opts) =>
      new Promise((resolve, reject) => pending.push({ ...opts, resolve, reject })),
  }
  return {
    port,
    pending,
    provider: { id: 'fake', resolve: (r: string) => (r === ref ? port : undefined) },
  }
}

function setup(opts: Partial<ModelHubOptions> = {}) {
  const clock = new FakeClock()
  const { port, pending, provider } = controllablePort()
  const hub = modelHub({ providers: [provider], clock, ...opts })
  const wrapped = hub.resolve('fake:m')!
  const call = (signal = new AbortController().signal) =>
    wrapped.call(input, { signal, onDelta: () => {} })
  return { clock, hub, wrapped, pending, call, port }
}

const modelError = (code: ModelError['code'], status?: number) =>
  new ModelCallError({
    code,
    message: code,
    retryable: true,
    attempts: [],
    ...(status ? { status } : {}),
  })

/** 让所有已挂起的调用失败，并等待结果落定。 */
async function failAll(s: ReturnType<typeof setup>, n: number, error: unknown) {
  for (let i = 0; i < n; i++) {
    const p = s.call()
    await s.clock.tick(0)
    s.pending.at(-1)!.reject(error)
    await p.catch(() => {})
  }
}

describe('modelHub', () => {
  it('AC-005 queues calls beyond the provider concurrency', async () => {
    const s = setup({ concurrency: { fake: 1 } })
    const first = s.call()
    const second = s.call()
    await s.clock.tick(0)
    expect(s.pending).toHaveLength(1)
    s.pending[0]!.resolve(response)
    await expect(first).resolves.toBe(response)
    await s.clock.tick(0)
    expect(s.pending).toHaveLength(2)
    s.pending[1]!.resolve(response)
    await expect(second).resolves.toBe(response)
  })

  it('AC-006 opens the breaker after five connection failures and fails fast', async () => {
    const s = setup()
    await failAll(s, 5, modelError('MODEL_CONNECTION'))
    const sixth = s.call()
    await expect(sixth).rejects.toMatchObject({
      detail: { code: 'MODEL_UNAVAILABLE', retryable: true },
    })
    expect(s.pending).toHaveLength(5)
    expect(s.hub.health()).toEqual([
      expect.objectContaining({ key: 'fake:m', dependency: 'model', state: 'open' }),
    ])
  })

  it('counts 5xx model errors as dependency failures', async () => {
    const s = setup()
    await failAll(s, 5, modelError('MODEL_ERROR', 503))
    expect(s.hub.health()[0]!.state).toBe('open')
  })

  it('does not let a late failure of a call admitted before opening reopen the breaker', async () => {
    const s = setup({ concurrency: { fake: 10 } })
    const early = s.call()
    await s.clock.tick(0)
    await failAll(s, 5, modelError('MODEL_CONNECTION'))
    await s.clock.tick(30_000)
    const probe = s.call()
    await s.clock.tick(0)
    expect(s.hub.health()[0]!.state).toBe('half_open')
    s.pending[0]!.reject(modelError('MODEL_CONNECTION'))
    await early.catch(() => {})
    expect(s.hub.health()[0]!.state).toBe('half_open')
    s.pending.at(-1)!.resolve(response)
    await expect(probe).resolves.toBe(response)
    expect(s.hub.health()[0]!.state).toBe('closed')
  })

  it('AC-007 does not count non-dependency errors', async () => {
    const s = setup()
    await failAll(s, 5, modelError('AUTH_FAILED'))
    const sixth = s.call()
    await s.clock.tick(0)
    expect(s.pending).toHaveLength(6)
    s.pending[5]!.resolve(response)
    await sixth
    expect(s.hub.health()[0]!.state).toBe('closed')
  })

  it('wraps unexpected errors as non-retryable MODEL_ERROR', async () => {
    const s = setup()
    const p = s.call()
    await s.clock.tick(0)
    s.pending[0]!.reject(new Error('socket hang up'))
    await expect(p).rejects.toMatchObject({
      detail: { code: 'MODEL_ERROR', message: 'socket hang up', retryable: false },
    })
  })

  it('AC-008 times out when no first token arrives and aborts the port call', async () => {
    const s = setup()
    const p = s.call()
    const caught = p.catch((e: unknown) => e)
    await s.clock.tick(120_000)
    expect(await caught).toMatchObject({ detail: { code: 'MODEL_TIMEOUT', retryable: true } })
    expect(s.pending[0]!.signal.aborted).toBe(true)
  })

  it('times out when the stream goes idle and when the call runs too long', async () => {
    const s = setup({ timeouts: { firstTokenMs: 100, idleMs: 50, totalMs: 1_000 } })
    const idle = s.call().catch((e: unknown) => e)
    await s.clock.tick(10)
    s.pending[0]!.onDelta({ type: 'text', text: 'a' })
    await s.clock.tick(50)
    expect(await idle).toMatchObject({ detail: { code: 'MODEL_TIMEOUT', message: '空闲超时' } })

    const total = s.call().catch((e: unknown) => e)
    for (let i = 0; i < 25; i++) {
      await s.clock.tick(40)
      s.pending[1]!.onDelta({ type: 'text', text: 'x' })
    }
    expect(await total).toMatchObject({
      detail: { code: 'MODEL_TIMEOUT', message: '单次时长超时' },
    })
  })

  it('removes a queued call when the caller aborts', async () => {
    const s = setup({ concurrency: { fake: 1 } })
    const first = s.call()
    const controller = new AbortController()
    const queued = s.call(controller.signal)
    controller.abort()
    await expect(queued).rejects.toSatisfy(isAbortError)
    await s.clock.tick(0)
    s.pending[0]!.resolve(response)
    await first
    const third = s.call()
    await s.clock.tick(0)
    expect(s.pending).toHaveLength(2)
    s.pending[1]!.resolve(response)
    await third
  })

  it('rejects at once when the caller aborts during a call without touching the breaker', async () => {
    const s = setup()
    const controller = new AbortController()
    const p = s.call(controller.signal)
    await s.clock.tick(0)
    controller.abort()
    await expect(p).rejects.toSatisfy(isAbortError)
    expect(s.pending[0]!.signal.aborted).toBe(true)
    expect(s.hub.health()[0]!.state).toBe('closed')
    await expect(s.call(AbortSignal.abort())).rejects.toSatisfy(isAbortError)
    s.pending[0]!.reject(abortError())
  })

  it('forwards deltas while the call is running', async () => {
    const s = setup()
    const deltas: Delta[] = []
    const p = s.wrapped.call(input, {
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d),
    })
    await s.clock.tick(0)
    s.pending[0]!.onDelta({ type: 'text', text: 'he' })
    s.pending[0]!.resolve(response)
    await p
    expect(deltas).toEqual([{ type: 'text', text: 'he' }])
  })

  it('AC-009 resolves known references only and exposes prices', () => {
    const { provider } = controllablePort()
    const hub = modelHub({
      providers: [provider],
      default: 'fake:m',
      pricing: { 'fake:m': { input: 1, output: 2 } },
      clock: new FakeClock(),
    })
    expect(hub.resolve('unknown:x')).toBeUndefined()
    expect(hub.resolve('fake:other')).toBeUndefined()
    expect(hub.resolve('fake:m')).toBe(hub.resolve('fake:m'))
    expect(hub.resolve('fake:m')!.capabilities).toBe(caps)
    expect(hub.price('fake:m')).toEqual({ input: 1, output: 2 })
    expect(hub.price('fake:x')).toBeUndefined()
    expect(hub.defaultModel).toBe('fake:m')
  })

  it('AC-006 forwards the port settings on every access', () => {
    let current: unknown = { vendor: 'openai' }
    const port: ModelPort = {
      ref: 'fake:m',
      capabilities: caps,
      get settings() {
        return current
      },
      call: async () => {
        throw new Error('not called')
      },
    }
    const hub = modelHub({
      providers: [{ id: 'fake', resolve: (r: string) => (r === 'fake:m' ? port : undefined) }],
      clock: new FakeClock(),
    })
    const wrapped = hub.resolve('fake:m')!
    expect(wrapped.settings).toEqual({ vendor: 'openai' })
    current = { vendor: 'anthropic' }
    expect(wrapped.settings).toEqual({ vendor: 'anthropic' })
  })

  it('reads the capabilities from the provider on every access, not once when resolving', () => {
    let current: ModelCapabilities = caps
    const port: ModelPort = {
      ref: 'fake:m',
      get capabilities() {
        return current
      },
      call: async () => {
        throw new Error('not called')
      },
    }
    const hub = modelHub({
      providers: [{ id: 'fake', resolve: (r: string) => (r === 'fake:m' ? port : undefined) }],
      clock: new FakeClock(),
    })
    const wrapped = hub.resolve('fake:m')!
    expect(wrapped.capabilities.contextLimit).toBe(caps.contextLimit)
    current = { ...caps, contextLimit: 40_000 }
    expect(hub.resolve('fake:m')).toBe(wrapped)
    expect(wrapped.capabilities.contextLimit).toBe(40_000)
  })

  it('notifies health listeners until they unsubscribe', async () => {
    const s = setup({ breaker: { failureThreshold: 1 } })
    const states: string[] = []
    const off = s.hub.onHealth((h) => states.push(h.state))
    await failAll(s, 1, modelError('RATE_LIMITED'))
    off()
    await s.clock.tick(30_000)
    const probe = s.call()
    await s.clock.tick(0)
    s.pending.at(-1)!.resolve(response)
    await probe
    expect(states).toEqual(['open'])
  })
})
