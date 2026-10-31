import { describe, expect, it } from 'vitest'
import { isAbortError } from '../contracts/errors.js'
import { FakeClock } from '../testing/fake-clock.js'
import { callComponent } from './call-component.js'

describe('callComponent', () => {
  it('returns the value and duration', async () => {
    const clock = new FakeClock()
    const outcome = callComponent(
      () => new Promise<number>((resolve) => clock.setTimer(20, () => resolve(7))),
      { clock },
    )
    await clock.tick(20)
    expect(await outcome).toEqual({ ok: true, value: 7, durationMs: 20 })
    expect(clock.pending()).toBe(0)
  })

  it('captures thrown errors', async () => {
    const outcome = await callComponent(
      async () => {
        throw new Error('broken')
      },
      { clock: new FakeClock() },
    )
    expect(outcome).toMatchObject({ ok: false, timedOut: false, durationMs: 0 })
    expect((outcome as { error: Error }).error.message).toBe('broken')
  })

  it('times out after 30 seconds by default', async () => {
    const clock = new FakeClock()
    const outcome = callComponent(() => new Promise(() => {}), { clock })
    await clock.tick(30_000)
    expect(await outcome).toMatchObject({ ok: false, timedOut: true, durationMs: 30_000 })
  })

  it('stops when the signal aborts', async () => {
    const controller = new AbortController()
    const outcome = callComponent(() => new Promise(() => {}), {
      clock: new FakeClock(),
      signal: controller.signal,
    })
    controller.abort()
    const result = await outcome
    expect(result.ok).toBe(false)
    expect(isAbortError((result as { error: unknown }).error)).toBe(true)
  })
})
