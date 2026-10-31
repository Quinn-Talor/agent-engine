import { describe, expect, it } from 'vitest'
import { isAbortError } from '../contracts/errors.js'
import { FakeClock } from '../testing/fake-clock.js'
import { AdmissionTimeoutError, createAdmission } from './admission.js'

describe('createAdmission', () => {
  it('AC-010 queues beyond the global limit and reports the queued time', async () => {
    const clock = new FakeClock()
    const admission = createAdmission({ maxConcurrentRuns: 1, clock })
    const first = await admission.acquire({ environment: 'a' })
    expect(first.queuedMs).toBe(0)
    let second: { queuedMs: number } | undefined
    void admission.acquire({ environment: 'a' }).then((s) => (second = s))
    await clock.tick(250)
    expect(second).toBeUndefined()
    expect(admission.status()).toEqual({ running: 1, queued: 1 })
    first.release()
    await clock.tick(0)
    expect(second?.queuedMs).toBe(250)
    expect(admission.status()).toEqual({ running: 1, queued: 0 })
  })

  it('AC-011 lets another environment through while one environment is full', async () => {
    const clock = new FakeClock()
    const admission = createAdmission({ maxConcurrentRuns: 2, clock })
    const granted: string[] = []
    const take = (label: string, environment: string) =>
      admission
        .acquire({ environment, environmentLimit: environment === 'a' ? 1 : undefined })
        .then((slot) => {
          granted.push(label)
          return slot
        })
    const a1 = take('a1', 'a')
    void take('a2', 'a')
    void take('b1', 'b')
    await clock.tick(0)
    expect(granted).toEqual(['a1', 'b1'])
    ;(await a1).release()
    await clock.tick(0)
    expect(granted).toEqual(['a1', 'b1', 'a2'])
  })

  it('AC-012 rejects after the queue timeout and drops the waiter', async () => {
    const clock = new FakeClock()
    const admission = createAdmission({ maxConcurrentRuns: 1, queueTimeoutMs: 300_000, clock })
    await admission.acquire({ environment: 'a' })
    const waiting = admission.acquire({ environment: 'a' }).catch((e: unknown) => e)
    await clock.tick(300_000)
    expect(await waiting).toBeInstanceOf(AdmissionTimeoutError)
    expect(admission.status()).toEqual({ running: 1, queued: 0 })
  })

  it('removes a waiter when its signal is aborted', async () => {
    const clock = new FakeClock()
    const admission = createAdmission({ maxConcurrentRuns: 1, clock })
    const first = await admission.acquire({ environment: 'a' })
    const controller = new AbortController()
    const waiting = admission.acquire({ environment: 'a', signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toSatisfy(isAbortError)
    expect(admission.status().queued).toBe(0)
    first.release()
    expect(admission.status().running).toBe(0)
    await expect(
      admission.acquire({ environment: 'a', signal: AbortSignal.abort() }),
    ).rejects.toSatisfy(isAbortError)
  })

  it('ignores a second release', async () => {
    const admission = createAdmission({ maxConcurrentRuns: 2, clock: new FakeClock() })
    const slot = await admission.acquire({ environment: 'a' })
    slot.release()
    slot.release()
    expect(admission.status().running).toBe(0)
  })

  it('defaults to 20 concurrent runs', async () => {
    const admission = createAdmission({ clock: new FakeClock() })
    for (let i = 0; i < 20; i++) await admission.acquire({ environment: 'a' })
    void admission.acquire({ environment: 'a' })
    expect(admission.status()).toEqual({ running: 20, queued: 1 })
  })
})
