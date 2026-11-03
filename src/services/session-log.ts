// 会话日志（会话方案 §3、§6、§15）：从运行档案读出接续点与序号最大的一轮，推导下一轮带入的窗口与台账；
// 按记下的事件序号复核每一轮冻结的窗口（I17）。推导只读档案、不调用模型。

import type { Segment } from '../contracts/common.js'
import type {
  ArchiveStore,
  BlobRef,
  LedgerEntry,
  RunEvent,
  SessionStarted,
  TurnRef,
} from '../contracts/events.js'
import type { RunSummary } from '../contracts/run.js'
import { canonicalJson, parseCanonical } from '../core/definition/hash.js'
import {
  appendLedger,
  blobsForCarry,
  carry,
  CARRY_VERSION,
  ledgerEntries,
  type SessionWindow,
} from '../core/session/window.js'

type Started = Extract<RunEvent, { t: 'run_started' }>

/** 下一轮带入的东西：序号、接续点、窗口、台账及其来源。 */
export interface DerivedWindow {
  turn: number
  continues?: TurnRef
  window: SessionWindow
  ledger: LedgerEntry[]
  omitted: number
  ledgerFrom?: TurnRef
}

interface LoadedTurn {
  runId: string
  turn: number
  events: RunEvent[]
  session: SessionStarted
  input: Segment[]
  window: SessionWindow
}

const textOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? data : new TextDecoder().decode(data)

async function readEvents(archive: ArchiveStore, runId: string, upTo?: number) {
  const events: RunEvent[] = []
  for await (const e of archive.read(runId)) {
    if (upTo !== undefined && e.seq > upTo) break
    events.push(e)
  }
  return events
}

async function blobs(archive: ArchiveStore, refs: readonly BlobRef[]) {
  const map = new Map<BlobRef, string>()
  for (const ref of refs) map.set(ref, textOf(await archive.getBlob(ref)))
  return map
}

/** 读出一轮：只读到 `upTo` 为止；它自己带入的窗口在 `task.content` 与 `session.window` 里。 */
async function loadTurn(archive: ArchiveStore, runId: string, upTo?: number): Promise<LoadedTurn> {
  const events = await readEvents(archive, runId, upTo)
  const started = events.find((e): e is Started => e.t === 'run_started')
  if (!started?.session) {
    throw new Error(`会话日志：运行 ${runId} 不是会话的一轮`)
  }
  const content = parseCanonical(textOf(await archive.getBlob(started.task.content))) as {
    input: Segment[]
    history: SessionWindow['messages']
  }
  const { window } = started.session
  const summary =
    window.summary !== undefined ? textOf(await archive.getBlob(window.summary)) : undefined
  return {
    runId,
    turn: started.session.turn,
    events,
    session: started.session,
    input: content.input,
    window: {
      messages: content.history,
      turnStarts: window.turnStarts,
      ...(summary !== undefined ? { summary } : {}),
    },
  }
}

const refOf = (t: LoadedTurn): TurnRef => ({ runId: t.runId, seq: t.events.at(-1)?.seq ?? 0 })

async function carried(archive: ArchiveStore, prev: LoadedTurn | undefined) {
  if (!prev) return { messages: [], turnStarts: [] }
  return carry({
    turn: prev.turn,
    window: prev.window,
    input: prev.input,
    events: prev.events,
    blobs: await blobs(archive, blobsForCarry(prev.events)),
  })
}

/** 台账：那一轮的台账 + 那一轮及其子运行的副作用（会话方案 §9）。 */
async function ledgerAfter(archive: ArchiveStore, latest: LoadedTurn | undefined) {
  if (!latest) return { ledger: [], omitted: 0 }
  // 按开始时间、再按 runId 排序：档案的查询顺序不固定，台账要每次推导都一样（I17）。
  const children = (await archive.query({ rootRunId: latest.runId }))
    .filter((s) => s.runId !== latest.runId)
    .sort(
      (a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
    )
  const childEvents = await Promise.all(children.map((s) => readEvents(archive, s.runId)))
  return appendLedger(
    { ledger: latest.session.window.ledger, omitted: latest.session.window.ledgerOmitted ?? 0 },
    ledgerEntries(latest.turn, latest.events, childEvents),
  )
}

/** 会话里的轮（有序号的根运行），按序号排列。 */
export async function sessionTurns(archive: ArchiveStore, session: string): Promise<RunSummary[]> {
  return (await archive.query({ session }))
    .filter((s) => s.turn !== undefined)
    .sort((a, b) => a.turn! - b.turn!)
}

/**
 * 推导会话下一轮带入的窗口：`continues` 不写时接最新的一轮，`null` 从头开始。接续点不是这个会话里的
 * 一轮时返回原因。
 */
export async function deriveWindow(
  archive: ArchiveStore,
  req: { session: string; continues?: string | null },
): Promise<{ ok: true; derived: DerivedWindow } | { ok: false; message: string }> {
  const turns = await sessionTurns(archive, req.session)
  const latestSummary = turns.at(-1)
  const prevId = req.continues === undefined ? latestSummary?.runId : req.continues
  if (prevId !== null && prevId !== undefined && !turns.some((t) => t.runId === prevId)) {
    return { ok: false, message: `接续点 ${prevId} 不是会话 ${req.session} 里的一轮` }
  }
  const prev = prevId ? await loadTurn(archive, prevId) : undefined
  const latest = latestSummary
    ? latestSummary.runId === prev?.runId
      ? prev
      : await loadTurn(archive, latestSummary.runId)
    : undefined
  const { ledger, omitted } = await ledgerAfter(archive, latest)
  return {
    ok: true,
    derived: {
      turn: (latestSummary?.turn ?? 0) + 1,
      ...(prev ? { continues: refOf(prev) } : {}),
      window: await carried(archive, prev),
      ledger,
      omitted,
      ...(latest ? { ledgerFrom: refOf(latest) } : {}),
    },
  }
}

/**
 * I17：同一 carry 版本下，每一轮冻结的窗口等于 carry(接续点的窗口与日志，读到记下的序号为止)，
 * 台账等于来源那一轮的台账加它及其子运行的副作用。接续点已被保留清理的轮记为"链已过期"，不算违反。
 */
export async function sessionLogIssues(archive: ArchiveStore, session: string): Promise<string[]> {
  const issues: string[] = []
  const turns = await sessionTurns(archive, session)
  const known = new Set(turns.map((t) => t.runId))
  const numbers = new Set<number>()
  for (const summary of turns) {
    const own = await loadTurn(archive, summary.runId)
    const label = `第 ${own.turn} 轮（${own.runId}）`
    if (numbers.has(own.turn)) issues.push(`${label}：序号重复`)
    numbers.add(own.turn)
    const { session: meta } = own
    if (meta.window.version !== CARRY_VERSION) continue
    const sources = [meta.continues, meta.window.ledgerFrom].filter((r) => r !== undefined)
    // 接续点或台账来源已被保留清理（链已过期）：无从复核，不算违反。
    if (sources.some((r) => !known.has(r.runId))) continue
    const prev = meta.continues
      ? await loadTurn(archive, meta.continues.runId, meta.continues.seq)
      : undefined
    const expected = await carried(archive, prev)
    if (canonicalJson(expected.messages) !== canonicalJson(own.window.messages)) {
      issues.push(`${label}：带入的窗口与 carry 推导的不一致`)
    }
    if (
      canonicalJson(expected.turnStarts) !== canonicalJson(own.window.turnStarts) ||
      expected.summary !== own.window.summary
    ) {
      issues.push(`${label}：窗口的轮起点或摘要与 carry 推导的不一致`)
    }
    const source = meta.window.ledgerFrom
      ? await loadTurn(archive, meta.window.ledgerFrom.runId, meta.window.ledgerFrom.seq)
      : undefined
    const ledger = await ledgerAfter(archive, source)
    if (
      canonicalJson(ledger.ledger) !== canonicalJson(meta.window.ledger) ||
      ledger.omitted !== (meta.window.ledgerOmitted ?? 0)
    ) {
      issues.push(`${label}：副作用台账与推导的不一致`)
    }
  }
  return issues
}
