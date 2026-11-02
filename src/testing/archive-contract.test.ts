import { describe, expect, it } from 'vitest'
import { memoryArchive, type ArchiveStore } from '../sdk.js'
import { archiveStoreContract } from './archive-contract.js'

describe('archiveStoreContract on memoryArchive', () => {
  const cases = archiveStoreContract(() => memoryArchive())

  it('AC-013 defines at least eight cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8)
  })

  for (const c of cases) it(`AC-013 ${c.name}`, c.run)
})

describe('archiveStoreContract on a broken store', () => {
  /** 查询结果交给 `patch` 改写，其他操作原样转发。 */
  const rewriteQuery = (
    patch: (found: Awaited<ReturnType<ArchiveStore['query']>>) => typeof found,
  ) =>
    archiveStoreContract(() => {
      const inner = memoryArchive()
      return {
        append: (runId, events) => inner.append(runId, events),
        read: (runId, fromSeq) => inner.read(runId, fromSeq),
        putBlob: (data) => inner.putBlob(data),
        getBlob: (ref) => inner.getBlob(ref),
        query: async (filter) => patch(await inner.query(filter)),
        pin: (runId, reason) => inner.pin(runId, reason),
        retain: (policy) => inner.retain(policy),
      }
    }).find((c) => c.name === 'lists unfinished runs without a status')!

  it('AC-013 fails a store whose query hides unfinished runs', async () => {
    const c = rewriteQuery((found) => found.filter((s) => s.status !== undefined))
    await expect(c.run()).rejects.toThrow('没有结束的运行')
  })

  it('AC-013 fails a store that gives unfinished runs a status', async () => {
    const c = rewriteQuery((found) => found.map((s) => ({ ...s, status: s.status ?? 'failed' })))
    await expect(c.run()).rejects.toThrow('没有结束的运行')
  })
})
