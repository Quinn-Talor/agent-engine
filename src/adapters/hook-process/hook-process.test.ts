import { describe, expect, it } from 'vitest'
import { processExec } from './hook-process.js'

describe('processExec', () => {
  it('AC-001 pipes input to the command and collects its output', async () => {
    const r = await processExec(
      'cat; echo done; echo oops >&2; exit 3',
      '{"hook_event_name":"Stop"}',
      {
        timeoutMs: 5000,
      },
    )
    expect(r).toEqual({
      exitCode: 3,
      stdout: '{"hook_event_name":"Stop"}done\n',
      stderr: 'oops\n',
      timedOut: false,
    })
  })

  it('AC-001 runs in the given directory', async () => {
    const r = await processExec('pwd', '', { timeoutMs: 5000, cwd: '/' })
    expect(r.stdout.trim()).toBe('/')
    await expect(
      processExec('pwd', '', { timeoutMs: 5000, cwd: '/nonexistent-dir-xyz' }),
    ).rejects.toThrow()
  })

  it('AC-002 ends a command that outlives its timeout', async () => {
    const started = Date.now()
    const r = await processExec('sleep 5', '', { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('AC-002 kills a command that ignores SIGTERM', async () => {
    const r = await processExec("trap '' TERM; sleep 5", '', { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
  })

  it('AC-002 stops on cancellation', async () => {
    const controller = new AbortController()
    const pending = processExec('sleep 5', '', { timeoutMs: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow('aborted')
    await expect(
      processExec('true', '', { timeoutMs: 1000, signal: AbortSignal.abort() }),
    ).rejects.toThrow('aborted')
  })

  it('AC-003 keeps at most 1MB of output', async () => {
    const r = await processExec("head -c 1500000 /dev/zero | tr '\\0' a", '', { timeoutMs: 10_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.length).toBe(1_048_576)
  })

  it('ignores a command that does not read its input', async () => {
    const r = await processExec('exit 0', 'x'.repeat(200_000), { timeoutMs: 5000 })
    expect(r.exitCode).toBe(0)
  })
})
