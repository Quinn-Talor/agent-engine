import { describe, expect, it } from 'vitest'
import { systemClock } from '../sdk.js'
import { FakeClock } from './fake-clock.js'

describe('FakeClock', () => {
  it('AC-001 fires due timers in time order and advances now', async () => {
    const clock = new FakeClock()
    const fired: number[] = []
    clock.setTimer(100, () => fired.push(clock.now()))
    clock.setTimer(50, () => fired.push(clock.now()))
    await clock.tick(100)
    expect(fired).toEqual([50, 100])
    expect(clock.now()).toBe(100)
    expect(clock.pending()).toBe(0)
  })

  it('fires timers scheduled from a callback within the same tick', async () => {
    const clock = new FakeClock(10)
    const fired: string[] = []
    clock.setTimer(5, () => {
      fired.push('outer')
      clock.setTimer(0, () => fired.push('inner'))
    })
    await clock.tick(5)
    expect(fired).toEqual(['outer', 'inner'])
    expect(clock.now()).toBe(15)
  })

  it('does not fire cancelled timers', async () => {
    const clock = new FakeClock()
    let fired = false
    const cancel = clock.setTimer(10, () => {
      fired = true
    })
    cancel()
    await clock.tick(20)
    expect(fired).toBe(false)
    expect(clock.pending()).toBe(0)
  })

  it('lets promise continuations run between timers', async () => {
    const clock = new FakeClock()
    const order: string[] = []
    const wait = (ms: number) => new Promise<void>((r) => clock.setTimer(ms, r))
    void (async () => {
      await wait(10)
      order.push('a')
      await wait(10)
      order.push('b')
    })()
    await clock.tick(20)
    expect(order).toEqual(['a', 'b'])
  })

  it('rejects negative or non-finite durations without moving time', async () => {
    const clock = new FakeClock(100)
    let fired = false
    clock.setTimer(10, () => {
      fired = true
    })
    for (const ms of [-50, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(clock.tick(ms)).rejects.toThrow(`FakeClock.tick：时长必须是非负有限数：${ms}`)
    }
    expect(clock.now()).toBe(100)
    expect(fired).toBe(false)
  })
})

describe('systemClock', () => {
  it('reads real time and cancels timers', async () => {
    const clock = systemClock()
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1000)
    let fired = false
    clock.setTimer(0, () => {
      fired = true
    })()
    await new Promise((r) => setTimeout(r, 5))
    expect(fired).toBe(false)
  })
})
