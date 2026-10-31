import { describe, expect, it, vi } from 'vitest'
import type { HookExec } from '../contracts/capability.js'
import type { HookSpec } from '../contracts/component.js'
import { createHookRunner } from './hook-runner.js'

const spec = (patch: Partial<HookSpec> = {}): HookSpec => ({
  event: 'Stop',
  command: './check.sh',
  ...patch,
})

describe('createHookRunner', () => {
  it('AC-004 runs the command with JSON input and the default timeout', async () => {
    const exec = vi.fn<HookExec>(async () => ({
      exitCode: 0,
      stdout: 'plain text',
      stderr: '',
      timedOut: false,
    }))
    const runner = createHookRunner({ exec })
    expect(runner.kind).toBe('hook')
    const signal = new AbortController().signal
    const r = await runner.run(spec(), { hook_event_name: 'Stop' }, { signal, cwd: '/ws' })
    expect(exec).toHaveBeenCalledWith('./check.sh', '{"hook_event_name":"Stop"}', {
      timeoutMs: 10_000,
      signal,
      cwd: '/ws',
    })
    expect(r).toEqual({ exitCode: 0, stdout: 'plain text', stderr: '', timedOut: false })
    await runner.run(spec({ timeoutMs: 500 }), {})
    expect(exec.mock.calls[1]![2]).toEqual({ timeoutMs: 500 })
  })

  it.each([
    [0, ' {"decision":"block","reason":"x"} ', { decision: 'block', reason: 'x' }],
    [0, '{not json', undefined],
    [0, '[1,2]', undefined],
    [2, '{"decision":"block"}', undefined],
  ])('AC-004 parses JSON output only on success (exit %i, %s)', async (exitCode, stdout, json) => {
    const runner = createHookRunner({
      exec: async () => ({ exitCode, stdout, stderr: '', timedOut: false }),
    })
    const r = await runner.run(spec(), {})
    if (json) expect(r.json).toEqual(json)
    else expect(r).not.toHaveProperty('json')
  })
})
