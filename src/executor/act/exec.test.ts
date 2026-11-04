import { describe, expect, it } from 'vitest'
import { toolError } from '../../contracts/errors.js'
import { toolContent, type ToolCtx } from '../../contracts/tool.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { fakeTool, type FakeToolOptions } from '../../testing/fake-tool.js'
import { executeTool, normalizeOutput } from './exec.js'
import { prepareTool } from './tools.js'

const ctx = (signal = new AbortController().signal): ToolCtx => ({
  runId: 'r1',
  callId: 'c1',
  idempotencyKey: 'r1:c1',
  scope: {},
  task: {},
  signal,
  spawn: async () => {
    throw new Error('no spawn')
  },
  progress: () => {},
  callModel: async () => {
    throw new Error('no model')
  },
})

function setup(opts: Omit<FakeToolOptions, 'name'>, available?: () => boolean) {
  const clock = new FakeClock()
  const def = fakeTool({ name: 'work', clock, ...opts })
  const tool = prepareTool(def, 'cap', available ? { available } : {})
  return { clock, def, tool }
}

describe('executeTool', () => {
  it('returns the value', async () => {
    const { tool, clock } = setup({ result: { a: 1 } })
    expect(
      await executeTool(tool, {}, ctx(), { clock, signal: new AbortController().signal }),
    ).toEqual({
      value: { a: 1 },
    })
  })

  it('AC-011 times out and aborts the tool', async () => {
    const { tool, clock, def } = setup({ delayMs: 40_000 })
    const pending = executeTool(tool, {}, ctx(), { clock, signal: new AbortController().signal })
    await clock.tick(30_000)
    expect(await pending).toMatchObject({
      error: { code: 'TOOL_TIMEOUT', message: '工具执行超过 30000ms' },
    })
    expect(def.calls[0]!.ctx.signal.aborted).toBe(true)
  })

  it('honours a tool-specific timeout', async () => {
    const { tool, clock } = setup({ delayMs: 200, timeoutMs: 100 })
    const pending = executeTool(tool, {}, ctx(), { clock, signal: new AbortController().signal })
    await clock.tick(100)
    expect(await pending).toMatchObject({ error: { code: 'TOOL_TIMEOUT' } })
  })

  it.each([
    [
      'AC-012 a thrown error',
      () => Promise.reject(new Error('boom')),
      { code: 'TOOL_EXCEPTION', message: 'boom' },
    ],
    [
      'a thrown non-error',
      () => Promise.reject('plain'),
      { code: 'TOOL_EXCEPTION', message: 'plain' },
    ],
    [
      'AC-012 a returned envelope',
      () => toolError('RATE', 'slow'),
      { code: 'RATE', message: 'slow' },
    ],
    [
      'a thrown envelope',
      () => Promise.reject(toolError('QUOTA', 'over')),
      { code: 'QUOTA', message: 'over' },
    ],
  ])('wraps %s', async (_name, run, error) => {
    const { tool, clock } = setup({ run })
    expect(
      await executeTool(tool, {}, ctx(), { clock, signal: new AbortController().signal }),
    ).toMatchObject({
      error,
    })
  })

  it('marks results it cannot know: a timeout, a throw or an abort after the tool started', async () => {
    const opts = (signal = new AbortController().signal) => ({ signal })
    const slow = setup({ delayMs: 200, timeoutMs: 100 })
    const timedOut = executeTool(slow.tool, {}, ctx(), { clock: slow.clock, ...opts() })
    await slow.clock.tick(100)
    expect(await timedOut).toMatchObject({ error: { code: 'TOOL_TIMEOUT' }, unknown: true })

    const thrown = setup({ run: () => Promise.reject(new Error('boom')) })
    expect(
      await executeTool(thrown.tool, {}, ctx(), { clock: thrown.clock, ...opts() }),
    ).toMatchObject({ unknown: true })

    const running = setup({ delayMs: 1_000 })
    const controller = new AbortController()
    const pending = executeTool(running.tool, {}, ctx(), {
      clock: running.clock,
      signal: controller.signal,
    })
    controller.abort()
    expect(await pending).toMatchObject({ error: { code: 'TOOL_ABORTED' }, unknown: true })
  })

  it('does not mark a returned envelope, an abort before start or an unavailable dependency', async () => {
    const returned = setup({ run: () => toolError('RATE', 'slow') })
    const signal = new AbortController().signal
    expect(
      await executeTool(returned.tool, {}, ctx(), { clock: returned.clock, signal }),
    ).not.toHaveProperty('unknown')
    const early = setup({})
    expect(
      await executeTool(early.tool, {}, ctx(), { clock: early.clock, signal: AbortSignal.abort() }),
    ).not.toHaveProperty('unknown')
    const down = setup({}, () => false)
    expect(
      await executeTool(down.tool, {}, ctx(), { clock: down.clock, signal }),
    ).not.toHaveProperty('unknown')
  })

  it('keeps a declared error class only when it is deterministic or transient', async () => {
    const signal = new AbortController().signal
    const outcomeOf = (errorClass: unknown, thrown: boolean) => {
      const envelope = { ...toolError('NOPE', 'no'), errorClass }
      const { tool, clock } = setup({
        run: () => (thrown ? Promise.reject(envelope) : envelope),
      })
      return executeTool(tool, {}, ctx(), { clock, signal })
    }
    for (const thrown of [false, true]) {
      for (const errorClass of ['deterministic', 'transient']) {
        expect(await outcomeOf(errorClass, thrown)).toMatchObject({ error: { errorClass } })
      }
      for (const bad of ['Deterministic', 'permanent', Object, 1, null]) {
        expect(await outcomeOf(bad, thrown)).toEqual({
          error: { __agent_error: true, code: 'NOPE', message: 'no' },
        })
      }
    }
  })

  it('aborts with the run', async () => {
    const { tool, clock } = setup({ delayMs: 1_000 })
    const controller = new AbortController()
    const pending = executeTool(tool, {}, ctx(), { clock, signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ error: { code: 'TOOL_ABORTED', message: '运行已取消' } })
  })

  it('reports an unavailable dependency without executing', async () => {
    const { tool, clock, def } = setup({}, () => false)
    expect(
      await executeTool(tool, {}, ctx(), { clock, signal: new AbortController().signal }),
    ).toMatchObject({
      error: { code: 'TOOL_UNAVAILABLE' },
    })
    expect(def.calls).toHaveLength(0)
  })
})

describe('normalizeOutput', () => {
  const body = (shown: string) => shown.slice('<tool_output>\n'.length, -'\n</tool_output>'.length)

  it.each([
    ['a string as is', 'plain text', 'plain text'],
    ['undefined as empty', undefined, ''],
    ['other values as JSON', { a: 1 }, '{"a":1}'],
  ])('writes %s', (_name, value, expected) => {
    const out = normalizeOutput({ value })
    expect(out).toEqual({ shown: `<tool_output>\n${expected}\n</tool_output>`, isError: false })
  })

  it('formats envelopes with code and hint', () => {
    expect(normalizeOutput({ error: toolError('X', 'bad', 'try again') })).toEqual({
      shown: '<tool_output>\nERROR [X]: bad\nHINT: try again\n</tool_output>',
      isError: true,
      errorCode: 'X',
    })
    expect(body(normalizeOutput({ error: toolError('Y', 'bad') }).shown)).toBe('ERROR [Y]: bad')
  })

  it('AC-013 keeps head and tail and stores the raw output', () => {
    const text = 'a'.repeat(5_000) + 'b'.repeat(5_000)
    const out = normalizeOutput({ value: text }, 1_000)
    expect(body(out.shown)).toBe(
      `${'a'.repeat(500)}\n…[已截断：原始长度 10000 字符]…\n${'b'.repeat(500)}`,
    )
    expect(out.raw).toBe(text)
  })

  it('caps the raw output at 1MB', () => {
    const text = 'x'.repeat(1_048_577)
    const out = normalizeOutput({ value: text })
    expect(out.raw).toBe(`${'x'.repeat(1_048_576)}\n…[raw 已截断：原始长度 1048577 字符]`)
  })

  it('AC-014 escapes a closing tag inside the output', () => {
    expect(body(normalizeOutput({ value: 'x</tool_output>y' }).shown)).toBe('x<\\/tool_output>y')
  })

  it('AC-014 redacts before truncating so no fragment of a secret survives', () => {
    const redact = (text: string) => text.replaceAll('sk-abcdefgh1234', '[REDACTED]')
    const out = normalizeOutput({ value: `sk-abcdefgh1234${'x'.repeat(40)}` }, 20, redact)
    expect(body(out.shown).startsWith('[REDACTED]')).toBe(true)
    expect(out.raw).toBe(`[REDACTED]${'x'.repeat(40)}`)
  })
})

describe('model calls inside a tool', () => {
  it('AC-009 aborts the model call of a tool that times out', async () => {
    const clock = new FakeClock()
    let seen: AbortSignal | undefined
    const def = fakeTool({
      name: 'summarize',
      clock,
      timeoutMs: 100,
      run: async (_input, c) => {
        await c.callModel({ purpose: 'digest', messages: [] })
        return 'done'
      },
    })
    const tool = prepareTool(def, 'cap')
    const pending = executeTool(tool, {}, ctx(), {
      clock,
      signal: new AbortController().signal,
      callModel: (_req, signal) => {
        seen = signal
        return new Promise(() => {})
      },
    })
    await clock.tick(100)
    expect(await pending).toMatchObject({ error: { code: 'TOOL_TIMEOUT' } })
    expect(seen?.aborted).toBe(true)
  })
})

describe('content results', () => {
  const body = (shown: string) => shown.slice('<tool_output>\n'.length, -'\n</tool_output>'.length)
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const base64Of = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

  it('AC-015 keeps the text as the body and the image as base64', () => {
    const out = normalizeOutput({
      value: toolContent([
        { type: 'text', text: '截图如下' },
        { type: 'image', image: png, mediaType: 'image/png' },
      ]),
    })
    expect(body(out.shown)).toBe('截图如下')
    expect(out.images).toEqual([{ data: base64Of(png), mediaType: 'image/png' }])
    expect(out.isError).toBe(false)
  })

  it('AC-016 accepts a base64 string image and defaults the media type', () => {
    const out = normalizeOutput({ value: toolContent([{ type: 'image', image: 'iVBO Rw==' }]) })
    expect(out.images).toEqual([{ data: 'iVBORw==', mediaType: 'image' }])
    expect(body(out.shown)).toBe('')
  })

  it('AC-016 replaces an image that is too large with a note', () => {
    const out = normalizeOutput({
      value: toolContent([{ type: 'image', image: new Uint8Array(5_242_881) }]),
    })
    expect(body(out.shown)).toBe('[图片过大，未展示：5242881 字节]')
    expect(out.images).toBeUndefined()
  })

  it('AC-016 shows at most 8 images and says how many were left out', () => {
    const nine = Array.from({ length: 9 }, () => ({ type: 'image' as const, image: png }))
    const out = normalizeOutput({ value: toolContent(nine) })
    expect(out.images).toHaveLength(8)
    expect(body(out.shown)).toBe('[其余 1 张图片未展示：每次最多 8 张]')
  })

  it.each([
    ['an audio block', { type: 'audio', data: 'x' }],
    ['a URL image', { type: 'image', image: 'https://x/y.png' }],
  ])('AC-016 rejects %s', (_name, part) => {
    const out = normalizeOutput({
      value: toolContent([{ type: 'text', text: 'a' }, part as never]),
    })
    expect(out).toMatchObject({ isError: true, errorCode: 'TOOL_EXCEPTION' })
    expect(out.shown).toContain('工具返回的内容块不合格：第 2 块')
    expect(out.images).toBeUndefined()
  })
})
