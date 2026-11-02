import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isAbortError } from '../sdk.js'
import type { ToolCtx } from '../contracts/tool.js'
import { FakeClock } from './fake-clock.js'
import { fakeTool } from './fake-tool.js'

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
})

describe('fakeTool', () => {
  it('records calls and returns the scripted result', async () => {
    const tool = fakeTool({ name: 'search', result: { hits: 1 } })
    expect(await tool.execute({ q: 'x' }, ctx())).toEqual({ hits: 1 })
    expect(tool.calls.map((c) => c.input)).toEqual([{ q: 'x' }])
    expect(await fakeTool({ name: 'plain' }).execute({}, ctx())).toBe('ok')
  })

  it('accepts any object by default', () => {
    const schema = fakeTool({ name: 't' }).inputSchema as z.ZodType
    expect(schema.safeParse({ anything: 1 }).success).toBe(true)
  })

  it('runs a custom function and fills the optional fields it was given', async () => {
    const tool = fakeTool({
      name: 'write',
      description: 'writes',
      inputSchema: z.object({ path: z.string() }),
      run: (input) => `wrote ${(input as { path: string }).path}`,
      effect: 'side_effect',
      exclusive: true,
      timeoutMs: 10,
      maxOutputChars: 100,
      risk: 'high',
      access: (input) => ({ write: [(input as { path: string }).path] }),
      intent: { kind: 'complete', code: 'finish' },
    })
    expect(await tool.execute({ path: '/a' }, ctx())).toBe('wrote /a')
    expect(tool.description).toBe('writes')
    expect(tool.execution).toEqual({
      effect: 'side_effect',
      exclusive: true,
      timeoutMs: 10,
      maxOutputChars: 100,
    })
    expect(tool.safety?.risk).toBe('high')
    expect(tool.safety?.access?.({ path: '/a' })).toEqual({ write: ['/a'] })
    expect(tool.semantics).toEqual({ intent: { kind: 'complete', code: 'finish' } })
    expect(fakeTool({ name: 'bare' }).execution).toBeUndefined()
  })

  it('waits on the clock and stops when aborted', async () => {
    const clock = new FakeClock()
    const tool = fakeTool({ name: 'slow', delayMs: 100, clock })
    let done = false
    void tool.execute({}, ctx()).then(() => (done = true))
    await clock.tick(99)
    expect(done).toBe(false)
    await clock.tick(1)
    expect(done).toBe(true)

    const controller = new AbortController()
    const pending = tool.execute({}, ctx(controller.signal))
    controller.abort()
    await expect(pending).rejects.toSatisfy(isAbortError)
  })
})
