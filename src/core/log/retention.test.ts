import { describe, expect, it } from 'vitest'
import { expiredRuns, type RetainedRun } from './retention.js'

const DAY = 86_400_000
const now = 100 * DAY
const run = (runId: string, patch: Partial<RetainedRun> = {}): RetainedRun => ({
  runId,
  rootRunId: runId,
  environment: 'chat',
  endedAt: now - 40 * DAY,
  pinned: false,
  ...patch,
})
const expired = (runs: RetainedRun[], environments?: Record<string, number>) =>
  [...expiredRuns(runs, { defaultDays: 30, now, ...(environments ? { environments } : {}) })].sort()

describe('expiredRuns', () => {
  it('§8.5 expires runs outside a session one by one, by their environment', () => {
    expect(
      expired(
        [
          run('old'),
          run('fresh', { endedAt: now - DAY }),
          run('open', { endedAt: undefined }),
          run('pinned', { pinned: true }),
          run('kept-longer', { environment: 'audit' }),
        ],
        { audit: 90 },
      ),
    ).toEqual(['old'])
  })

  it('§13 expires a session only when every run in it, children included, has expired', () => {
    const session = [
      run('t1', { session: 's' }),
      run('t1-child', { rootRunId: 't1' }),
      run('t2', { session: 's', endedAt: now - DAY }),
    ]
    expect(expired(session)).toEqual([])
    const old = session.map((r) => ({ ...r, endedAt: now - 40 * DAY }))
    expect(expired(old)).toEqual(['t1', 't1-child', 't2'])
  })

  it('§13 keeps the whole session when one run is pinned or still open', () => {
    const base = [run('t1', { session: 's' }), run('t2', { session: 's' })]
    expect(expired([base[0]!, { ...base[1]!, pinned: true }])).toEqual([])
    expect(expired([base[0]!, { ...base[1]!, endedAt: undefined }])).toEqual([])
  })

  it('§13 applies each run its own environment days', () => {
    const turns = [
      run('t1', { session: 's' }),
      run('t2', { session: 's', environment: 'audit', endedAt: now - 60 * DAY }),
    ]
    expect(expired(turns, { audit: 90 })).toEqual([])
    expect(expired(turns, { audit: 50 })).toEqual(['t1', 't2'])
  })
})
