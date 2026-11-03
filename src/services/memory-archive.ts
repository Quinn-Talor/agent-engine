// 内存运行档案（设计 §8.5）：引擎的默认运行档案；与 SQLite 实现共用存储契约。
// 保留清理不删最近写过（含去重命中）的 blob：运行可能刚拿到引用、还没写进事件。会话按整体过期与删除。

import type { Clock } from '../contracts/common.js'
import type {
  BlobRef,
  RetainReport,
  RetentionPolicy,
  RunEvent,
  RunFilter,
} from '../contracts/events.js'
import { SCHEMA_VERSION, type ArchiveStore } from '../contracts/events.js'
import type { RunSummary } from '../contracts/run.js'
import { sha256Hex } from '../core/definition/hash.js'
import { summarize } from '../core/log/projections.js'
import { expiredRuns } from '../core/log/retention.js'
import { upcastEvent } from '../core/log/upcast.js'
import { systemClock } from './clock.js'

const DAY_MS = 86_400_000
/** putBlob 之后、引用它的事件写入之前的宽限期（一个环节的时长远小于它）。 */
const BLOB_GRACE_MS = DAY_MS
const BLOB_REF = /sha256:[0-9a-f]{64}/g
const SUMMARY_EVENTS = new Set<RunEvent['t']>(['run_started', 'step_ended', 'run_ended'])

interface StoredRun {
  events: RunEvent[]
  version: number
  pinned: boolean
  summary?: RunSummary
}

function refsOf(events: readonly RunEvent[]): Set<BlobRef> {
  return new Set(JSON.stringify(events).match(BLOB_REF) ?? [])
}

function matches(s: RunSummary, f: RunFilter): boolean {
  return (
    (f.subject === undefined || s.subject === f.subject) &&
    (f.session === undefined || s.session === f.session) &&
    (f.environment === undefined || s.environment === f.environment) &&
    (f.agentId === undefined || s.agentId === f.agentId) &&
    (f.status === undefined || s.status === f.status) &&
    (f.parentRunId === undefined || s.parentRunId === f.parentRunId) &&
    (f.rootRunId === undefined || s.rootRunId === f.rootRunId) &&
    (f.startedAfter === undefined || s.startedAt >= f.startedAfter) &&
    (f.startedBefore === undefined || s.startedAt < f.startedBefore)
  )
}

export function memoryArchive(opts: { clock?: Clock } = {}): ArchiveStore {
  const clock = opts.clock ?? systemClock()
  const runs = new Map<string, StoredRun>()
  const blobs = new Map<BlobRef, string | Uint8Array>()
  /** 每个 blob 最近一次 putBlob（写入或去重命中）的时间。 */
  const touched = new Map<BlobRef, number>()

  /** 删除运行，再清除只被它们引用、且在 `touchedBefore` 之前最后写入的 blob。 */
  const remove = (ids: ReadonlySet<string>, touchedBefore: number): RetainReport => {
    const removed: StoredRun[] = []
    for (const runId of ids) {
      const run = runs.get(runId)
      if (!run) continue
      removed.push(run)
      runs.delete(runId)
    }
    // 还在用的运行（含没有结局的运行）引用的 blob 保留。
    const keep = refsOf([...runs.values()].flatMap((r) => r.events))
    let removedBlobs = 0
    for (const ref of refsOf(removed.flatMap((r) => r.events))) {
      if (keep.has(ref) || (touched.get(ref) ?? -Infinity) > touchedBefore) continue
      touched.delete(ref)
      if (blobs.delete(ref)) removedBlobs += 1
    }
    return { removedRuns: removed.length, removedBlobs }
  }

  return {
    async append(runId, events) {
      if (events.length === 0) return
      const run = runs.get(runId) ?? { events: [], version: SCHEMA_VERSION, pinned: false }
      const last = run.events.at(-1)?.seq ?? 0
      events.forEach((e, i) => {
        const expected = last + 1 + i
        if (e.seq !== expected) {
          throw new Error(`archive: seq 不连续（期望 ${expected}，实际 ${e.seq}）`)
        }
      })
      run.events.push(...events)
      const started = events.find((e) => e.t === 'run_started')
      if (started?.t === 'run_started') run.version = started.schemaVersion
      if (events.some((e) => SUMMARY_EVENTS.has(e.t))) {
        const summary = summarize(run.events)
        if (summary) run.summary = { ...summary, runId, pinned: run.pinned }
      }
      runs.set(runId, run)
    },

    async *read(runId, fromSeq = 1) {
      const run = runs.get(runId)
      if (!run) return
      for (const e of run.events) if (e.seq >= fromSeq) yield upcastEvent(e, run.version)
    },

    async putBlob(data) {
      const ref = `sha256:${sha256Hex(data)}`
      if (!blobs.has(ref)) blobs.set(ref, data)
      touched.set(ref, clock.now())
      return ref
    },

    async getBlob(ref) {
      const data = blobs.get(ref)
      if (data === undefined) throw new Error(`archive: blob 不存在 ${ref}`)
      return data
    },

    async query(filter) {
      const found = [...runs.values()]
        .map((r) => r.summary)
        .filter((s): s is RunSummary => s !== undefined && matches(s, filter))
        .sort((a, b) => b.startedAt - a.startedAt)
      return filter.limit === undefined ? found : found.slice(0, filter.limit)
    },

    async pin(runId, _reason) {
      const run = runs.get(runId)
      if (!run) throw new Error(`archive: 运行不存在 ${runId}`)
      run.pinned = true
      if (run.summary) run.summary = { ...run.summary, pinned: true }
    },

    async retain(policy: RetentionPolicy): Promise<RetainReport> {
      const expired = expiredRuns(
        [...runs.entries()].flatMap(([runId, r]) =>
          r.summary
            ? [
                {
                  runId,
                  rootRunId: r.summary.rootRunId,
                  ...(r.summary.session !== undefined ? { session: r.summary.session } : {}),
                  environment: r.summary.environment,
                  ...(r.summary.endedAt !== undefined ? { endedAt: r.summary.endedAt } : {}),
                  pinned: r.pinned,
                },
              ]
            : [],
        ),
        policy,
      )
      return remove(expired, clock.now() - BLOB_GRACE_MS)
    },

    async deleteSession(session) {
      const turns = [...runs.entries()].filter(([, r]) => r.summary?.session === session)
      const roots = new Set(turns.map(([runId]) => runId))
      const members = [...runs.entries()].filter(
        ([runId, r]) => roots.has(runId) || roots.has(r.summary?.rootRunId ?? ''),
      )
      if (members.some(([, r]) => r.summary?.endedAt === undefined)) {
        throw new Error(`archive: 会话 ${session} 有没结束的运行，不能删除`)
      }
      // 会话结束之后没有被再次写入过的 blob 只属于这个会话（或被别的运行的事件引用，下面会留下）。
      const lastEnded = Math.max(-Infinity, ...members.map(([, r]) => r.summary!.endedAt!))
      return remove(
        new Set(members.map(([runId]) => runId)),
        Math.max(lastEnded, clock.now() - BLOB_GRACE_MS),
      )
    },
  }
}
