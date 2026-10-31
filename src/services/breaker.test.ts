import { describe, expect, it } from 'vitest'
import type { BreakerStatus } from '../contracts/engine.js'
import { FakeClock } from '../testing/fake-clock.js'
import { createBreaker } from './breaker.js'

function setup() {
  const clock = new FakeClock(1_000)
  const changes: BreakerStatus[] = []
  const breaker = createBreaker({
    key: 'fake:model',
    dependency: 'model',
    clock,
    onChange: (s) => changes.push(s),
  })
  const fail = (n: number) => {
    for (let i = 0; i < n; i++) breaker.admit()!.onFailure()
  }
  return { clock, changes, breaker, fail }
}

describe('createBreaker', () => {
  it('AC-002 opens after five consecutive failures', () => {
    const { breaker, changes, fail } = setup()
    fail(4)
    expect(breaker.status().state).toBe('closed')
    fail(1)
    expect(breaker.admit()).toBeUndefined()
    expect(breaker.status()).toEqual({
      key: 'fake:model',
      dependency: 'model',
      state: 'open',
      since: 1_000,
    })
    expect(changes.map((c) => c.state)).toEqual(['open'])
  })

  it('counts failures reported without a ticket, such as a dropped connection', () => {
    const { breaker } = setup()
    for (let i = 0; i < 5; i++) breaker.onFailure()
    expect(breaker.status().state).toBe('open')
    breaker.onSuccess()
    expect(breaker.status().state).toBe('closed')
  })

  it('reports cooling only while open and inside the cooldown', async () => {
    const { breaker, clock, fail } = setup()
    expect(breaker.cooling()).toBe(false)
    fail(5)
    expect(breaker.cooling()).toBe(true)
    await clock.tick(30_000)
    expect(breaker.cooling()).toBe(false)
    expect(breaker.status().state).toBe('open')
  })

  it('resets the count on success', () => {
    const { breaker, fail } = setup()
    fail(4)
    breaker.admit()!.onSuccess()
    fail(4)
    expect(breaker.status().state).toBe('closed')
  })

  it('AC-003 lets one probe through after the cooldown and closes on success', async () => {
    const { breaker, clock, changes, fail } = setup()
    fail(5)
    await clock.tick(29_999)
    expect(breaker.admit()).toBeUndefined()
    await clock.tick(1)
    const probe = breaker.admit()
    expect(probe).toBeDefined()
    expect(breaker.status().state).toBe('half_open')
    expect(breaker.admit()).toBeUndefined()
    probe!.onSuccess()
    expect(breaker.status()).toMatchObject({ state: 'closed', since: 31_000 })
    expect(changes.map((c) => c.state)).toEqual(['open', 'half_open', 'closed'])
  })

  it('AC-004 reopens when the probe fails and restarts the cooldown', async () => {
    const { breaker, clock, fail } = setup()
    fail(5)
    await clock.tick(30_000)
    breaker.admit()!.onFailure()
    expect(breaker.status()).toMatchObject({ state: 'open', since: 31_000 })
    await clock.tick(29_999)
    expect(breaker.admit()).toBeUndefined()
  })

  it('frees the probe slot when the probe is released without a result', async () => {
    const { breaker, clock, fail } = setup()
    fail(5)
    await clock.tick(30_000)
    const probe = breaker.admit()!
    probe.release()
    probe.release()
    expect(breaker.status().state).toBe('half_open')
    expect(breaker.admit()).toBeDefined()
    expect(breaker.admit()).toBeUndefined()
  })

  it('keeps the probe slot when a call admitted earlier is released', async () => {
    const { breaker, clock, fail } = setup()
    const early = breaker.admit()!
    fail(5)
    await clock.tick(30_000)
    expect(breaker.admit()).toBeDefined()
    early.release()
    expect(breaker.admit()).toBeUndefined()
  })

  it('ignores a late failure of a call admitted before the breaker opened', async () => {
    const { breaker, clock, changes, fail } = setup()
    const early = breaker.admit()!
    fail(5)
    await clock.tick(10_000)
    early.onFailure()
    expect(breaker.status()).toMatchObject({ state: 'open', since: 1_000 })
    await clock.tick(20_000)
    const probe = breaker.admit()!
    expect(probe).toBeDefined()
    early.onFailure()
    expect(breaker.status().state).toBe('half_open')
    probe.onSuccess()
    expect(changes.map((c) => c.state)).toEqual(['open', 'half_open', 'closed'])
  })

  it('reports each ticket once', () => {
    const { breaker } = setup()
    const ticket = breaker.admit()!
    for (let i = 0; i < 4; i++) breaker.admit()!.onFailure()
    ticket.onFailure()
    ticket.onFailure()
    expect(breaker.status().state).toBe('open')
    const fresh = createBreaker({ key: 'k', dependency: 'model', clock: new FakeClock() })
    const once = fresh.admit()!
    for (let i = 0; i < 5; i++) once.onFailure()
    expect(fresh.status().state).toBe('closed')
  })

  it('honours a custom policy', () => {
    const clock = new FakeClock()
    const breaker = createBreaker({
      key: 'k',
      dependency: 'mcp',
      clock,
      policy: { failureThreshold: 1, cooldownMs: 10 },
    })
    breaker.onFailure()
    expect(breaker.status().state).toBe('open')
  })
})
