// 存储契约测试（设计 §13 `archiveStoreContract`）：任何 ArchiveStore 实现都必须通过。
// 框架无关：返回用例列表，由调用方交给自己的测试框架；断言用 node:assert/strict。

import assert from 'node:assert/strict'
import type { ArchiveStore, RunEvent } from '../contracts/events.js'
import { SCHEMA_VERSION } from '../contracts/events.js'
import type { RunResult } from '../contracts/run.js'

export interface ContractCase {
  name: string
  run(): Promise<void>
}

const DAY_MS = 86_400_000
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function started(seq: number, at: number, subject: string): RunEvent {
  return {
    seq,
    at,
    t: 'run_started',
    agent: { id: 'contract-agent', fingerprint: 'agent-fp' },
    task: {
      fingerprint: 'task-fp',
      content: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      subject,
    },
    environment: { name: 'contract', fingerprint: 'env-fp', principalReachable: false },
    engine: { fingerprint: 'engine-fp' },
    capabilities: [],
    unavailable: [],
    model: 'contract:model',
    contextLimit: 10_000,
    outputReserve: 0,
    queuedMs: 0,
    rootRunId: 'root',
    schemaVersion: SCHEMA_VERSION,
  }
}

function steer(seq: number, at: number): RunEvent {
  return { seq, at, t: 'steer_received', text: `steer ${seq}` }
}

function ended(seq: number, at: number, runId: string): RunEvent {
  const result: RunResult = {
    runId,
    status: 'completed',
    model: 'contract:model',
    usage: { ...usage(), main: usage(), memory: usage(), supervision: usage(), children: usage() },
    steps: 0,
    toolCalls: 0,
  }
  return { seq, at, t: 'run_ended', result }
}

/** 会话的一轮：根运行，带序号与接续点；`content` 引用一个 blob。 */
function turnStarted(
  runId: string,
  turn: number,
  opts: { continues?: string; content?: string; rootRunId?: string; session?: string } = {},
): RunEvent {
  const base = started(1, 1_000, opts.session ?? 's')
  if (base.t !== 'run_started') throw new Error('unreachable')
  const isChild = opts.rootRunId !== undefined
  return {
    ...base,
    task: { ...base.task, ...(opts.content ? { content: opts.content } : {}) },
    rootRunId: opts.rootRunId ?? runId,
    ...(isChild
      ? {}
      : {
          session: {
            id: opts.session ?? 's',
            turn,
            ...(opts.continues ? { continues: { runId: opts.continues, seq: 2 } } : {}),
            window: { version: 1, turnStarts: [], ledger: [], tokens: 0 },
          },
        }),
  }
}

async function readSeqs(store: ArchiveStore, runId: string, fromSeq?: number): Promise<number[]> {
  const seqs: number[] = []
  for await (const e of store.read(runId, fromSeq)) seqs.push(e.seq)
  return seqs
}

export function archiveStoreContract(
  make: () => ArchiveStore | Promise<ArchiveStore>,
): ContractCase[] {
  const finishedRun = (runId: string, at: number, subject = 'contract') => [
    started(1, at, subject),
    steer(2, at + 1),
    ended(3, at + 2, runId),
  ]

  return [
    {
      name: 'appends and reads events in order',
      async run() {
        const store = await make()
        await store.append('r1', [started(1, 1, 's'), steer(2, 2), steer(3, 3)])
        assert.deepEqual(await readSeqs(store, 'r1'), [1, 2, 3])
      },
    },
    {
      name: 'reads from a sequence number',
      async run() {
        const store = await make()
        await store.append('r1', [started(1, 1, 's'), steer(2, 2), steer(3, 3)])
        assert.deepEqual(await readSeqs(store, 'r1', 2), [2, 3])
      },
    },
    {
      name: 'rejects a sequence gap atomically',
      async run() {
        const store = await make()
        await assert.rejects(store.append('r1', [started(1, 1, 's'), steer(3, 3)]))
        assert.deepEqual(await readSeqs(store, 'r1'), [])
      },
    },
    {
      name: 'continues the sequence across appends',
      async run() {
        const store = await make()
        await store.append('r1', [started(1, 1, 's'), steer(2, 2)])
        await store.append('r1', [steer(3, 3)])
        await assert.rejects(store.append('r1', [steer(3, 4)]))
        assert.deepEqual(await readSeqs(store, 'r1'), [1, 2, 3])
      },
    },
    {
      name: 'deduplicates blobs by content',
      async run() {
        const store = await make()
        const a = await store.putBlob('same text')
        assert.equal(await store.putBlob('same text'), a)
        assert.equal(await store.getBlob(a), 'same text')
        const bytes = await store.putBlob(new Uint8Array([7, 8, 9]))
        assert.deepEqual(Array.from((await store.getBlob(bytes)) as Uint8Array), [7, 8, 9])
      },
    },
    {
      name: 'fails on a missing blob',
      async run() {
        const store = await make()
        await assert.rejects(store.getBlob(`sha256:${'0'.repeat(64)}`))
      },
    },
    {
      name: 'summarises runs for queries',
      async run() {
        const store = await make()
        await store.append('r1', finishedRun('r1', 1_000, 'subject-1'))
        await store.append('r2', finishedRun('r2', 2_000, 'subject-2'))
        const found = await store.query({ subject: 'subject-1' })
        assert.equal(found.length, 1)
        assert.equal(found[0]!.runId, 'r1')
        assert.equal(found[0]!.status, 'completed')
        assert.equal(found[0]!.agentId, 'contract-agent')
      },
    },
    {
      // 引擎启动时靠它找出中断的运行并补齐结尾（设计 §3.12）。
      name: 'lists unfinished runs without a status',
      async run() {
        const store = await make()
        await store.append('running', [started(1, 1_000, 'subject-1'), steer(2, 1_001)])
        await store.append('done', finishedRun('done', 2_000))
        const found = await store.query({})
        const running = found.find((s) => s.runId === 'running')
        assert.ok(running, '没有结束的运行也要出现在 query({}) 的结果里')
        assert.equal(running.status, undefined, '没有结束的运行不能有状态')
        assert.equal(found.find((s) => s.runId === 'done')?.status, 'completed')
      },
    },
    {
      name: 'pins runs and keeps them on retention',
      async run() {
        const store = await make()
        await store.append('pinned', finishedRun('pinned', 1_000))
        await store.append('expired', finishedRun('expired', 1_000))
        await store.pin('pinned', 'contract')
        const report = await store.retain({ defaultDays: 1, now: 10 * DAY_MS })
        assert.equal(report.removedRuns, 1)
        assert.deepEqual(await readSeqs(store, 'pinned'), [1, 2, 3])
        assert.deepEqual(await readSeqs(store, 'expired'), [])
      },
    },
    {
      // 受理失败、排队超时、须知拦下的运行只有 run_ended：也要能查到、能清理。
      name: 'summarises and retains runs that ended before they started',
      async run() {
        const store = await make()
        const refused = ended(1, 1_000, 'refused')
        assert.equal(refused.t, 'run_ended')
        await store.append('refused', [
          {
            ...refused,
            result: { ...refused.result, status: 'stopped', code: 'notice_blocked' },
            origin: {
              rootRunId: 'refused',
              environment: 'contract',
              environmentFingerprint: 'env-fp',
              engineFingerprint: 'engine-fp',
              agentId: 'contract-agent',
              agentFingerprint: 'agent-fp',
              subject: 'subject-3',
            },
          } as RunEvent,
        ])
        const [found] = await store.query({ status: 'stopped' })
        assert.equal(found?.runId, 'refused')
        assert.equal(found?.code, 'notice_blocked')
        assert.equal(found?.subject, 'subject-3')
        assert.equal(found?.steps, 0)
        const report = await store.retain({ defaultDays: 1, now: 10 * DAY_MS })
        assert.equal(report.removedRuns, 1)
        assert.deepEqual(await readSeqs(store, 'refused'), [])
      },
    },
    {
      name: 'queries the turns of a session with their number and continuation point',
      async run() {
        const store = await make()
        await store.append('t1', [turnStarted('t1', 1), ended(2, 1_000, 't1')])
        await store.append('t2', [turnStarted('t2', 2, { continues: 't1' }), ended(2, 2_000, 't2')])
        await store.append('x1', [
          turnStarted('x1', 1, { session: 'other' }),
          ended(2, 1_000, 'x1'),
        ])
        const turns = (await store.query({ session: 's' })).sort((a, b) => a.turn! - b.turn!)
        assert.deepEqual(
          turns.map((t) => [t.runId, t.session, t.turn, t.continues]),
          [
            ['t1', 's', 1, undefined],
            ['t2', 's', 2, 't1'],
          ],
        )
      },
    },
    {
      // 会话方案 §13：会话里每个运行都过期了，整个会话才一起清理，不会只剩半条链。
      name: 'retains a session as a whole',
      async run() {
        const store = await make()
        await store.append('t1', [turnStarted('t1', 1), ended(2, 1_000, 't1')])
        await store.append('c1', [turnStarted('c1', 0, { rootRunId: 't1' }), ended(2, 1_000, 'c1')])
        await store.append('t2', [turnStarted('t2', 2), ended(2, 9.5 * DAY_MS, 't2')])
        assert.equal((await store.retain({ defaultDays: 1, now: 10 * DAY_MS })).removedRuns, 0)
        assert.deepEqual(await readSeqs(store, 't1'), [1, 2])
        assert.equal((await store.retain({ defaultDays: 1, now: 20 * DAY_MS })).removedRuns, 3)
        assert.deepEqual(await readSeqs(store, 't2'), [])
      },
    },
    {
      name: 'deletes a session with its child runs and blobs, and refuses an open session',
      async run() {
        const store = await make()
        const own = await store.putBlob('会话 s 的内容')
        const shared = await store.putBlob('两个会话都引用的内容')
        // blob 写在会话结束之前：会话结束之后没有再被写入，不受宽限期保护。
        const end = Date.now() + DAY_MS
        await store.append('t1', [turnStarted('t1', 1, { content: own }), ended(2, end, 't1')])
        await store.append('c1', [
          turnStarted('c1', 0, { rootRunId: 't1', content: shared }),
          ended(2, end, 'c1'),
        ])
        await store.append('x1', [
          turnStarted('x1', 1, { session: 'other', content: shared }),
          ended(2, 1_000, 'x1'),
        ])
        await store.append('o1', [turnStarted('o1', 1, { session: 'open' })])
        await assert.rejects(store.deleteSession('open'), /没结束/)
        const report = await store.deleteSession('s')
        assert.deepEqual(report, { removedRuns: 2, removedBlobs: 1 })
        assert.deepEqual(await readSeqs(store, 'c1'), [])
        await assert.rejects(store.getBlob(own))
        assert.equal(await store.getBlob(shared), '两个会话都引用的内容')
        assert.equal((await store.query({ session: 'other' })).length, 1)
      },
    },
    {
      name: 'keeps unfinished runs on retention',
      async run() {
        const store = await make()
        await store.append('running', [started(1, 1_000, 's')])
        await store.retain({ defaultDays: 1, now: 10 * DAY_MS })
        assert.deepEqual(await readSeqs(store, 'running'), [1])
      },
    },
  ]
}
