// SQLite 运行档案（设计 §8.5）：与内存档案共用存储契约。WAL、synchronous=NORMAL、busy_timeout；一次 append
// 是一个事务，seq 必须连续；run_started、step_ended、run_ended 时更新 runs；超过 4KB 的 blob 用 gzip；
// 保留按执行环境配置天数，固定的运行永久保留，清理后对 blob 做标记清除（最近写过的 blob 不清除）。
// 表结构版本记在 meta.schema_version：版本不同的文件拒绝打开，不做迁移。会话按整体过期与删除（会话方案 §13）。
// 一个档案同一时刻只给一个引擎实例：打开时占住旁边的锁文件，第二个打开者直接报错（设计 §3.12 补齐的前提）。
// better-sqlite3 是可选的 peer 依赖：调用 sqliteArchive() 时才加载（方案 D4）。

import { createRequire } from 'node:module'
import { gunzipSync, gzipSync } from 'node:zlib'
import type BetterSqlite3 from 'better-sqlite3'
import {
  expiredRuns,
  SCHEMA_VERSION,
  sha256Hex,
  summarize,
  systemClock,
  upcastEvent,
} from '../../sdk.js'
import type {
  ArchiveStore,
  BlobRef,
  Clock,
  RetainReport,
  RetentionPolicy,
  RunEvent,
  RunFilter,
  RunSummary,
  RunUsage,
} from '../../sdk.js'

const DAY_MS = 86_400_000
/** putBlob 之后、引用它的事件写入之前的宽限期：运行可能刚去重拿到引用、还没写进事件。 */
const BLOB_GRACE_MS = DAY_MS
const BUSY_TIMEOUT_MS = 5000
/** 表结构版本：不同版本的文件拒绝打开（不迁移），删除后重建。 */
const STORE_VERSION = 3
const COMPRESS_ABOVE = 4096
const BLOB_REF = /sha256:[0-9a-f]{64}/g
const SUMMARY_EVENTS = new Set<RunEvent['t']>(['run_started', 'step_ended', 'run_ended'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, root_run_id TEXT NOT NULL, parent_run_id TEXT,
  environment TEXT NOT NULL, environment_fp TEXT NOT NULL, engine_fp TEXT NOT NULL,
  agent_id TEXT NOT NULL, agent_version TEXT, agent_fp TEXT NOT NULL, model TEXT NOT NULL, subject TEXT,
  status TEXT, code TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, steps INTEGER NOT NULL, tool_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  memory_tokens INTEGER NOT NULL, supervision_tokens INTEGER NOT NULL, cost REAL,
  pinned INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL, usage_json TEXT NOT NULL,
  session TEXT, turn INTEGER, continues TEXT
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, size INTEGER NOT NULL, encoding TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_subject ON runs(subject, started_at);
CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS runs_root ON runs(root_run_id);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, agent_version, started_at);
CREATE INDEX IF NOT EXISTS runs_environment ON runs(environment, status, started_at);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session, turn);
`

interface RunRow {
  run_id: string
  root_run_id: string
  parent_run_id: string | null
  environment: string
  environment_fp: string
  engine_fp: string
  agent_id: string
  agent_version: string | null
  agent_fp: string
  model: string
  subject: string | null
  session: string | null
  turn: number | null
  continues: string | null
  status: RunSummary['status'] | null
  code: string | null
  started_at: number
  ended_at: number | null
  steps: number
  tool_calls: number
  cost: number | null
  pinned: number
  usage_json: string
}

const tokens = (u: { input: number; output: number }) => u.input + u.output

/** 事件版本 1 写下的摘要没有 tools 分组，按全 0 读出。 */
function usageOf(json: string): RunUsage {
  const stored = JSON.parse(json) as Omit<RunUsage, 'tools'> & { tools?: RunUsage['tools'] }
  return { ...stored, tools: stored.tools ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}

function summaryOf(row: RunRow): RunSummary {
  return {
    runId: row.run_id,
    rootRunId: row.root_run_id,
    ...(row.parent_run_id !== null ? { parentRunId: row.parent_run_id } : {}),
    environment: row.environment,
    environmentFingerprint: row.environment_fp,
    engineFingerprint: row.engine_fp,
    agentId: row.agent_id,
    ...(row.agent_version !== null ? { agentVersion: row.agent_version } : {}),
    agentFingerprint: row.agent_fp,
    model: row.model,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.session !== null ? { session: row.session } : {}),
    ...(row.turn !== null ? { turn: row.turn } : {}),
    ...(row.continues !== null ? { continues: row.continues } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.code !== null ? { code: row.code } : {}),
    startedAt: row.started_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    steps: row.steps,
    toolCalls: row.tool_calls,
    usage: usageOf(row.usage_json),
    ...(row.cost !== null ? { cost: row.cost } : {}),
    pinned: row.pinned === 1,
  }
}

function filterSql(f: RunFilter): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  const eq: Array<[string, unknown]> = [
    ['subject', f.subject],
    ['session', f.session],
    ['environment', f.environment],
    ['agent_id', f.agentId],
    ['status', f.status],
    ['parent_run_id', f.parentRunId],
    ['root_run_id', f.rootRunId],
  ]
  for (const [column, value] of eq) {
    if (value === undefined) continue
    clauses.push(`${column} = ?`)
    params.push(value)
  }
  if (f.startedAfter !== undefined) {
    clauses.push('started_at >= ?')
    params.push(f.startedAfter)
  }
  if (f.startedBefore !== undefined) {
    clauses.push('started_at < ?')
    params.push(f.startedBefore)
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** 新文件记下表结构版本；已有文件的版本必须相同，否则拒绝打开。 */
function checkVersion(db: BetterSqlite3.Database): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(STORE_VERSION),
    )
    return
  }
  if (Number(row.value) !== STORE_VERSION) {
    throw new Error(
      `archive: 档案文件的表结构版本 ${row.value} 与本版本的 ${STORE_VERSION} 不一致，请删除后重建`,
    )
  }
}

/**
 * 占住 `<file>.lock`：独占锁在连接关闭或进程退出（包括被杀）时由操作系统释放，不会留下过期的占用。
 * 锁另放一个文件，档案本身仍允许别的连接只读打开。
 */
function claim(Database: typeof BetterSqlite3, file: string): BetterSqlite3.Database | undefined {
  if (file === '' || file === ':memory:') return undefined
  const lock = new Database(`${file}.lock`, { timeout: 0 })
  try {
    lock.pragma('locking_mode = EXCLUSIVE')
    lock.exec('BEGIN EXCLUSIVE; COMMIT')
    return lock
  } catch (error) {
    lock.close()
    if ((error as { code?: unknown }).code !== 'SQLITE_BUSY') throw error
    throw new Error(
      `archive: 档案 ${file} 正被另一个引擎实例使用；一个档案同一时刻只能给一个引擎实例`,
      { cause: error },
    )
  }
}

export function sqliteArchive(opts: {
  file: string
  retention?: { defaultDays: number; environments?: Record<string, number> }
  /** blob 写入时间与打开时的保留清理用它取时间。 */
  clock?: Clock
}): ArchiveStore & { close(): void } {
  // 可选的 peer 依赖：用到时才加载原生模块，导入包入口不要求安装它。
  const Database = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
  const clock = opts.clock ?? systemClock()
  // 先占锁再打开档案：没占到锁的进程不碰档案，打开时的保留清理也不做。
  const lock = claim(Database, opts.file)
  let db: BetterSqlite3.Database
  try {
    db = new Database(opts.file)
  } catch (error) {
    lock?.close()
    throw error
  }
  try {
    // 读者与写者并存（单写多读）：遇到锁先等待，不立即报 SQLITE_BUSY。
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    // 先查版本再建表：版本不同的文件不能被这个版本的建表语句改动。
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    checkVersion(db)
    db.exec(SCHEMA)
  } catch (error) {
    db.close()
    lock?.close()
    throw error
  }

  const lastSeq = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE run_id = ?')
  const touchBlob = db.prepare('UPDATE blobs SET touched_at = MAX(touched_at, ?) WHERE sha = ?')
  const insertEvent = db.prepare(
    'INSERT INTO events (run_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)',
  )
  const eventsOf = db.prepare(
    'SELECT payload FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq',
  )
  const startedOf = db.prepare(
    "SELECT payload FROM events WHERE run_id = ? AND type = 'run_started'",
  )
  const upsertRun = db.prepare(`
    INSERT INTO runs (run_id, root_run_id, parent_run_id, environment, environment_fp, engine_fp, agent_id, agent_version,
      agent_fp, model, subject, status, code, started_at, ended_at, steps, tool_calls, input_tokens, output_tokens,
      cache_read, cache_write, memory_tokens, supervision_tokens, cost, schema_version, usage_json, session, turn, continues)
    VALUES (@run_id, @root_run_id, @parent_run_id, @environment, @environment_fp, @engine_fp, @agent_id, @agent_version,
      @agent_fp, @model, @subject, @status, @code, @started_at, @ended_at, @steps, @tool_calls, @input_tokens, @output_tokens,
      @cache_read, @cache_write, @memory_tokens, @supervision_tokens, @cost, @schema_version, @usage_json,
      @session, @turn, @continues)
    ON CONFLICT(run_id) DO UPDATE SET root_run_id = excluded.root_run_id, parent_run_id = excluded.parent_run_id,
      environment = excluded.environment, environment_fp = excluded.environment_fp, engine_fp = excluded.engine_fp,
      agent_id = excluded.agent_id, agent_version = excluded.agent_version, agent_fp = excluded.agent_fp,
      model = excluded.model, subject = excluded.subject, status = excluded.status, code = excluded.code,
      started_at = excluded.started_at, ended_at = excluded.ended_at, steps = excluded.steps,
      tool_calls = excluded.tool_calls, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read, cache_write = excluded.cache_write, memory_tokens = excluded.memory_tokens,
      supervision_tokens = excluded.supervision_tokens, cost = excluded.cost,
      schema_version = excluded.schema_version, usage_json = excluded.usage_json,
      session = excluded.session, turn = excluded.turn, continues = excluded.continues`)

  const allEvents = (runId: string): RunEvent[] =>
    (eventsOf.all(runId, 1) as Array<{ payload: string }>).map(
      (r) => JSON.parse(r.payload) as RunEvent,
    )

  const refreshSummary = (runId: string) => {
    const events = allEvents(runId)
    const summary = summarize(events)
    if (!summary) return
    const started = events.find((e) => e.t === 'run_started')
    const u = summary.usage
    upsertRun.run({
      run_id: runId,
      root_run_id: summary.rootRunId,
      parent_run_id: summary.parentRunId ?? null,
      environment: summary.environment,
      environment_fp: summary.environmentFingerprint,
      engine_fp: summary.engineFingerprint,
      agent_id: summary.agentId,
      agent_version: summary.agentVersion ?? null,
      agent_fp: summary.agentFingerprint,
      model: summary.model,
      subject: summary.subject ?? null,
      session: summary.session ?? null,
      turn: summary.turn ?? null,
      continues: summary.continues ?? null,
      status: summary.status ?? null,
      code: summary.code ?? null,
      started_at: summary.startedAt,
      ended_at: summary.endedAt ?? null,
      steps: summary.steps,
      tool_calls: summary.toolCalls,
      input_tokens: u.input,
      output_tokens: u.output,
      cache_read: u.cacheRead,
      cache_write: u.cacheWrite,
      memory_tokens: tokens(u.memory),
      supervision_tokens: tokens(u.supervision),
      cost: summary.cost ?? null,
      schema_version: started?.t === 'run_started' ? started.schemaVersion : SCHEMA_VERSION,
      usage_json: JSON.stringify(u),
    })
  }

  const appendBatch = db.transaction((runId: string, events: readonly RunEvent[]) => {
    const last = (lastSeq.get(runId) as { seq: number | null }).seq ?? 0
    events.forEach((e, i) => {
      const expected = last + 1 + i
      if (e.seq !== expected)
        throw new Error(`archive: seq 不连续（期望 ${expected}，实际 ${e.seq}）`)
      insertEvent.run(runId, e.seq, e.t, e.at, JSON.stringify(e))
    })
    if (events.some((e) => SUMMARY_EVENTS.has(e.t))) refreshSummary(runId)
  })

  /** 删除运行，再清除只被它们引用、且在 `touchedBefore` 之前最后写入的 blob。 */
  const remove = (ids: readonly string[], touchedBefore: number): RetainReport => {
    const released = new Set<string>()
    for (const runId of ids) {
      for (const e of eventsOf.all(runId, 1) as Array<{ payload: string }>) {
        for (const ref of e.payload.match(BLOB_REF) ?? []) released.add(ref)
      }
      db.prepare('DELETE FROM events WHERE run_id = ?').run(runId)
      db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId)
    }
    const kept = new Set<string>()
    for (const e of db.prepare('SELECT payload FROM events').iterate() as Iterable<{
      payload: string
    }>) {
      for (const ref of e.payload.match(BLOB_REF) ?? []) kept.add(ref)
    }
    let removedBlobs = 0
    const deleteBlob = db.prepare('DELETE FROM blobs WHERE sha = ? AND touched_at <= ?')
    for (const ref of released) {
      if (!kept.has(ref)) removedBlobs += deleteBlob.run(ref, touchedBefore).changes
    }
    return { removedRuns: ids.length, removedBlobs }
  }

  const retainNow = db.transaction((policy: RetentionPolicy): RetainReport => {
    const rows = db
      .prepare('SELECT run_id, root_run_id, session, environment, ended_at, pinned FROM runs')
      .all() as Array<{
      run_id: string
      root_run_id: string
      session: string | null
      environment: string
      ended_at: number | null
      pinned: number
    }>
    const expired = expiredRuns(
      rows.map((r) => ({
        runId: r.run_id,
        rootRunId: r.root_run_id,
        ...(r.session !== null ? { session: r.session } : {}),
        environment: r.environment,
        ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
        pinned: r.pinned === 1,
      })),
      policy,
    )
    // 宽限期内写过（含去重命中）的 blob 保留：运行可能刚拿到引用、还没写进事件。
    return remove([...expired], clock.now() - BLOB_GRACE_MS)
  })

  const deleteSessionNow = db.transaction((session: string): RetainReport => {
    const members = db
      .prepare(
        `SELECT run_id, ended_at FROM runs WHERE session = ?
          OR root_run_id IN (SELECT run_id FROM runs WHERE session = ?)`,
      )
      .all(session, session) as Array<{ run_id: string; ended_at: number | null }>
    if (members.some((r) => r.ended_at === null)) {
      throw new Error(`archive: 会话 ${session} 有没结束的运行，不能删除`)
    }
    // 会话结束之后没有被再次写入过的 blob 不受宽限期保护。
    const lastEnded = Math.max(-Infinity, ...members.map((r) => r.ended_at!))
    return remove(
      members.map((r) => r.run_id),
      Math.max(lastEnded, clock.now() - BLOB_GRACE_MS),
    )
  })

  const store: ArchiveStore & { close(): void } = {
    async append(runId, events) {
      if (events.length > 0) appendBatch(runId, events)
    },
    async *read(runId, fromSeq = 1) {
      const started = startedOf.get(runId) as { payload: string } | undefined
      const version = started
        ? (JSON.parse(started.payload) as { schemaVersion: number }).schemaVersion
        : SCHEMA_VERSION
      for (const r of eventsOf.all(runId, fromSeq) as Array<{ payload: string }>) {
        yield upcastEvent(JSON.parse(r.payload) as RunEvent, version)
      }
    },
    async putBlob(data) {
      const ref: BlobRef = `sha256:${sha256Hex(data)}`
      const now = clock.now()
      // 去重命中也记下时间：保留清理据此避开刚被拿去引用的 blob。
      if (touchBlob.run(now, ref).changes > 0) return ref
      const text = typeof data === 'string'
      const bytes = text ? Buffer.from(data, 'utf8') : Buffer.from(data)
      const compressed = bytes.length > COMPRESS_ABOVE
      const encoding = text ? (compressed ? 'gzip' : 'utf8') : compressed ? 'binary+gzip' : 'binary'
      db.prepare(
        'INSERT INTO blobs (sha, size, encoding, data, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(ref, bytes.length, encoding, compressed ? gzipSync(bytes) : bytes, now, now)
      return ref
    },
    async getBlob(ref) {
      const row = db.prepare('SELECT encoding, data FROM blobs WHERE sha = ?').get(ref) as
        { encoding: string; data: Buffer } | undefined
      if (!row) throw new Error(`archive: blob 不存在 ${ref}`)
      const bytes = row.encoding.endsWith('gzip') ? gunzipSync(row.data) : row.data
      return row.encoding.startsWith('binary') ? new Uint8Array(bytes) : bytes.toString('utf8')
    },
    async query(filter) {
      const { where, params } = filterSql(filter)
      const limit = filter.limit !== undefined ? ' LIMIT ?' : ''
      const rows = db
        .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC${limit}`)
        .all(...params, ...(filter.limit !== undefined ? [filter.limit] : [])) as RunRow[]
      return rows.map(summaryOf)
    },
    async pin(runId) {
      const changed = db.prepare('UPDATE runs SET pinned = 1 WHERE run_id = ?').run(runId).changes
      if (changed === 0) throw new Error(`archive: 运行不存在 ${runId}`)
    },
    async retain(policy) {
      return retainNow(policy)
    },
    async deleteSession(session) {
      return deleteSessionNow(session)
    },
    close: () => {
      db.close()
      lock?.close()
    },
  }

  if (opts.retention) retainNow({ ...opts.retention, now: clock.now() })
  return store
}
