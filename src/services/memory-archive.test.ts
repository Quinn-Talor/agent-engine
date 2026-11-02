import { describe, expect, it } from 'vitest'
import type { ArchiveStore, RunEvent } from '../contracts/events.js'
import {
  runEnded,
  runStarted,
  sequence,
  stepStarted,
  toolFinished,
} from '../core/log/events.fixture.js'
import { FakeClock } from '../testing/fake-clock.js'
import { memoryArchive } from './memory-archive.js'

const DAY = 86_400_000
const NOW = 100 * DAY

async function readAll(store: ArchiveStore, runId: string, fromSeq?: number): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const e of store.read(runId, fromSeq)) out.push(e)
  return out
}

const env = (name: string) => ({ name, fingerprint: `${name}-fp`, principalReachable: true })

describe('memoryArchive', () => {
  it('AC-009 rejects a sequence gap without writing anything', async () => {
    const store = memoryArchive()
    await store.append(
      'r1',
      sequence([runStarted(), stepStarted(1), { t: 'steer_received', text: 'x' }]),
    )
    const gap = { ...sequence([stepStarted(2)])[0]!, seq: 5 }
    await expect(store.append('r1', [gap])).rejects.toThrow('seq 不连续（期望 4，实际 5）')
    expect(await readAll(store, 'r1')).toHaveLength(3)
  })

  it('ignores an empty append', async () => {
    const store = memoryArchive()
    await store.append('r1', [])
    expect(await readAll(store, 'r1')).toEqual([])
  })

  it('AC-010 deduplicates blobs and fails on missing ones', async () => {
    const store = memoryArchive()
    const a = await store.putBlob('same')
    const b = await store.putBlob('same')
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await store.getBlob(a)).toBe('same')
    await expect(store.getBlob(`sha256:${'0'.repeat(64)}`)).rejects.toThrow('blob 不存在')
  })

  it('AC-015 reads from a sequence number and yields nothing for unknown runs', async () => {
    const store = memoryArchive()
    await store.append(
      'r1',
      sequence([runStarted(), stepStarted(1), { t: 'steer_received', text: 'x' }]),
    )
    expect((await readAll(store, 'r1', 3)).map((e) => e.seq)).toEqual([3])
    expect(await readAll(store, 'missing')).toEqual([])
  })

  it('AC-012 queries summaries by subject, newest first, with a limit', async () => {
    const store = memoryArchive()
    const run = (subject: string, startAt: number) =>
      sequence([runStarted({ task: { fingerprint: 't', subject } }), runEnded()], startAt)
    await store.append('r1', run('s1', 1_000))
    await store.append('r2', run('s1', 5_000))
    await store.append('r3', run('s2', 9_000))
    const found = await store.query({ subject: 's1', limit: 1 })
    expect(found.map((s) => [s.runId, s.startedAt])).toEqual([['r2', 5_000]])
    expect(
      (await store.query({ startedAfter: 5_000, startedBefore: 9_000 })).map((s) => s.runId),
    ).toEqual(['r2'])
    expect(
      (await store.query({ environment: 'env', status: 'completed' })).map((s) => s.runId),
    ).toEqual(['r3', 'r2', 'r1'])
  })

  it('AC-011 removes expired, unpinned runs and the blobs only they used', async () => {
    const clock = new FakeClock(NOW - 40 * DAY)
    const store = memoryArchive({ clock })
    const own = await store.putBlob('only run 1')
    const shared = await store.putBlob('shared')
    const pending = await store.putBlob('not referenced yet')
    const old = NOW - 40 * DAY
    const run = (environment: string, blobs: string[]) =>
      sequence(
        [
          runStarted({ environment: env(environment) }),
          ...blobs.map((shown, i) => toolFinished(`c${i}`, { shown })),
          runEnded(),
        ],
        old,
      )
    await store.append('r1', run('a', [own, shared]))
    await store.append('r2', run('a', []))
    await store.append('r3', run('b', [shared]))
    await store.append('r4', sequence([runStarted({ environment: env('a') })], old))
    await store.pin('r2', 'cited by a report')
    await clock.tick(40 * DAY)

    const report = await store.retain({ defaultDays: 30, environments: { b: 60 }, now: NOW })
    expect(report).toEqual({ removedRuns: 1, removedBlobs: 1 })
    expect(await readAll(store, 'r1')).toEqual([])
    expect(await readAll(store, 'r2')).toHaveLength(2)
    expect(await readAll(store, 'r3')).toHaveLength(3)
    expect(await readAll(store, 'r4')).toHaveLength(1)
    await expect(store.getBlob(own)).rejects.toThrow()
    expect(await store.getBlob(shared)).toBe('shared')
    expect(await store.getBlob(pending)).toBe('not referenced yet')
    expect((await store.query({ agentId: 'agent' })).find((s) => s.runId === 'r2')?.pinned).toBe(
      true,
    )
  })

  it('keeps blobs written recently: a running run may have deduplicated against them', async () => {
    const clock = new FakeClock(NOW - 40 * DAY)
    const store = memoryArchive({ clock })
    const shared = await store.putBlob('shared')
    const old = NOW - 40 * DAY
    await store.append(
      'old',
      sequence([runStarted(), toolFinished('c1', { shown: shared }), runEnded()], old),
    )
    await store.append('running', sequence([runStarted()], NOW - DAY))
    await clock.tick(40 * DAY)
    // 运行中的 r 刚去重拿到同一个引用，事件还没写入。
    expect(await store.putBlob('shared')).toBe(shared)
    expect(await store.retain({ defaultDays: 30, now: NOW })).toEqual({
      removedRuns: 1,
      removedBlobs: 0,
    })
    expect(await store.getBlob(shared)).toBe('shared')
  })

  it('fails to pin an unknown run', async () => {
    await expect(memoryArchive().pin('missing', 'x')).rejects.toThrow('运行不存在 missing')
  })

  it('stores bytes as bytes', async () => {
    const store = memoryArchive()
    const ref = await store.putBlob(new Uint8Array([1, 2, 3]))
    expect(await store.getBlob(ref)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('does not summarise runs that never started', async () => {
    const store = memoryArchive()
    await store.append('r1', sequence([runEnded({ status: 'failed', code: 'admission_timeout' })]))
    expect(await store.query({})).toEqual([])
    expect(await readAll(store, 'r1')).toHaveLength(1)
  })
})
