// 会话的一轮（会话方案 §5、§12）：占住会话——同一引擎里同一会话一次只跑一轮，第二轮受理失败
// session_busy（同步判定）；等启动时的中断补齐完成，再从档案推导带入的窗口与台账。结束时释放。

import type { ArchiveStore } from '../../contracts/events.js'
import { deriveWindow, type DerivedWindow } from '../../services/session-log.js'

export interface SessionClaim {
  id: string
  derived: DerivedWindow
  release(): void
}

export type ClaimResult =
  { ok: true; claim: SessionClaim } | { ok: false; code: 'invalid_task'; message: string }

export interface SessionDeps {
  archive: ArchiveStore
  /** 会话 → 正在占用它的运行。 */
  sessions: Map<string, string>
  /** 启动时的中断补齐：补齐之前，档案里没结束的轮可能只是上次进程留下的。 */
  recovered: Promise<unknown>
}

/**
 * 占住会话：同步检查并占用，`startRun` 返回之前就知道这一轮会不会被拒（被拒的轮不收引导）。
 * 已被占用时返回 undefined；否则返回释放函数。
 */
export function occupySession(
  sessions: Map<string, string>,
  session: string,
  runId: string,
): (() => void) | undefined {
  if (sessions.has(session)) return undefined
  sessions.set(session, runId)
  return () => {
    if (sessions.get(session) === runId) sessions.delete(session)
  }
}

/** 已占住会话之后：等启动时的中断补齐完成，再推导窗口；失败时释放。 */
export async function deriveSession(
  deps: Pick<SessionDeps, 'archive' | 'recovered'>,
  release: () => void,
  req: { session: string; continues?: string | null },
): Promise<ClaimResult> {
  try {
    await deps.recovered
    const r = await deriveWindow(deps.archive, req)
    if (!r.ok) {
      release()
      return { ok: false, code: 'invalid_task', message: r.message }
    }
    return { ok: true, claim: { id: req.session, derived: r.derived, release } }
  } catch (error) {
    release()
    throw error
  }
}
