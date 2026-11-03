import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  emptyRunUsage,
  type RunEvent,
  type RunEventBody,
  type RunResult,
} from '../../sdk.js'
import { archiveStoreContract } from '../../testing/archive-contract.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { sqliteArchive } from './sqlite-archive.js'

const DAY = 86_400_000

// 适配器测试不能依赖 core/ 的测试数据，这里就地构造事件。
const usage = (input = 0, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0 })
const sequence = (bodies: RunEventBody[], startAt = 1_000): RunEvent[] =>
  bodies.map((body, i) => ({ ...body, seq: i + 1, at: startAt + i * 10 }) as RunEvent)
const runStarted = (
  patch: Partial<Extract<RunEventBody, { t: 'run_started' }>> = {},
): RunEventBody => ({
  t: 'run_started',
  agent: { id: 'agent', fingerprint: 'agent-fp' },
  task: {
    fingerprint: 'task-fp',
    content: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  },
  environment: { name: 'env', fingerprint: 'env-fp', principalReachable: true },
  engine: { fingerprint: 'engine-fp' },
  capabilities: [],
  unavailable: [],
  model: 'fake:model',
  contextLimit: 10_000,
  outputReserve: 0,
  queuedMs: 0,
  rootRunId: 'r1',
  schemaVersion: SCHEMA_VERSION,
  ...patch,
})
const stepStarted = (step: number): RunEventBody => ({ t: 'step_started', step })
const stepEnded = (step: number): RunEventBody => ({ t: 'step_ended', step })
const evaluated = (step: number): RunEventBody => ({
  t: 'evaluated',
  step,
  observation: {
    step,
    text: 'ok',
    toolCalls: [],
    allToolsFailed: null,
    isFinalCandidate: true,
    newInformation: false,
    finishReason: 'stop',
    interventions: { applied: [], violated: [] },
    pressure: { context: 0, steps: 0, time: 0, tokens: 0, cost: 0 },
    usage: usage(),
  },
  opinions: [],
  verdict: { complete: true, sources: ['default'] },
  decidedAt: 0,
})
const modelResponded = (step: number, u: ReturnType<typeof usage>): RunEventBody => ({
  t: 'model_responded',
  step,
  response: {
    text: 'ok',
    toolCalls: [],
    finishReason: 'stop',
    usage: u,
    warnings: [],
    attempts: [],
  },
  startedAt: 0,
})
const toolFinished = (callId: string, shown: string): RunEventBody => ({
  t: 'tool_finished',
  callId,
  capability: 'tools',
  effect: 'none',
  shown,
  isError: false,
  startedAt: 0,
  durationMs: 1,
})
const runEnded = (patch: Partial<RunResult> = {}): RunEventBody => ({
  t: 'run_ended',
  result: {
    runId: 'r1',
    status: 'completed',
    model: 'fake:model',
    usage: emptyRunUsage(),
    steps: 1,
    toolCalls: 0,
    ...patch,
  },
})
const dirs: string[] = []
const fileOf = () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-'))
  dirs.push(dir)
  return join(dir, 'runs.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function readAll(store: ReturnType<typeof sqliteArchive>, runId: string, fromSeq?: number) {
  const out: RunEvent[] = []
  for await (const e of store.read(runId, fromSeq)) out.push(e)
  return out
}

describe('sqliteArchive contract', () => {
  for (const c of archiveStoreContract(() => sqliteArchive({ file: fileOf() }))) {
    it(`AC-001 ${c.name}`, c.run)
  }
})

describe('sqliteArchive', () => {
  const run = (
    runId: string,
    at: number,
    environment = 'env',
    patch: Parameters<typeof runEnded>[0] = {},
  ) =>
    sequence(
      [
        runStarted({
          rootRunId: runId,
          environment: { name: environment, fingerprint: 'fp', principalReachable: true },
        }),
        stepStarted(1),
        modelResponded(1, usage(30, 4)),
        evaluated(1),
        stepEnded(1),
        runEnded({ runId, ...patch }),
      ],
      at,
    )

  it('AC-002 keeps everything across reopening the file', async () => {
    const file = fileOf()
    const first = sqliteArchive({ file })
    const events = run('r1', 1000)
    await first.append('r1', events)
    const ref = await first.putBlob('payload')
    await first.pin('r1', 'audit')
    first.close()

    const again = sqliteArchive({ file })
    expect(await readAll(again, 'r1')).toEqual(events)
    expect(await readAll(again, 'r1', 5)).toEqual(events.slice(4))
    expect(await again.getBlob(ref)).toBe('payload')
    expect(await again.query({})).toEqual([
      expect.objectContaining({ runId: 'r1', status: 'completed', pinned: true }),
    ])
    again.close()
  })

  it('AC-003 compresses large blobs and keeps binary data intact', async () => {
    const file = fileOf()
    const store = sqliteArchive({ file })
    const small = 'a'.repeat(4096)
    const large = 'b'.repeat(4097)
    const binary = new Uint8Array(5000).map((_, i) => i % 256)
    const refs = [
      await store.putBlob(small),
      await store.putBlob(large),
      await store.putBlob(binary),
    ]
    expect(await store.getBlob(refs[0]!)).toBe(small)
    expect(await store.getBlob(refs[1]!)).toBe(large)
    expect(await store.getBlob(refs[2]!)).toEqual(binary)
    expect(await store.putBlob(large)).toBe(refs[1])
    store.close()
    const db = new Database(file, { readonly: true })
    const rows = db.prepare('SELECT size, encoding FROM blobs ORDER BY size').all()
    db.close()
    expect(rows).toEqual([
      { size: 4096, encoding: 'utf8' },
      { size: 4097, encoding: 'gzip' },
      { size: 5000, encoding: 'binary+gzip' },
    ])
  })

  it('AC-004 creates the schema, indexes, version and WAL mode', () => {
    const file = fileOf()
    sqliteArchive({ file }).close()
    const db = new Database(file, { readonly: true })
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'runs_%' ORDER BY name",
      )
      .all()
    const columns = (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    const mode = db.pragma('journal_mode', { simple: true })
    const blobColumns = (
      db.prepare('PRAGMA table_info(blobs)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    db.close()
    expect(tables).toEqual([
      { name: 'blobs' },
      { name: 'events' },
      { name: 'meta' },
      { name: 'runs' },
    ])
    expect(indexes.map((i) => (i as { name: string }).name)).toEqual([
      'runs_agent',
      'runs_environment',
      'runs_parent',
      'runs_root',
      'runs_session',
      'runs_subject',
    ])
    expect(columns).toEqual(
      expect.arrayContaining([
        'run_id',
        'root_run_id',
        'parent_run_id',
        'environment',
        'environment_fp',
        'engine_fp',
        'agent_id',
        'agent_version',
        'agent_fp',
        'model',
        'subject',
        'status',
        'code',
        'started_at',
        'ended_at',
        'steps',
        'tool_calls',
        'input_tokens',
        'output_tokens',
        'cache_read',
        'cache_write',
        'memory_tokens',
        'supervision_tokens',
        'cost',
        'pinned',
        'schema_version',
        'session',
        'turn',
        'continues',
      ]),
    )
    // 表结构版本（不是事件格式版本 SCHEMA_VERSION）。
    expect(version).toEqual({ value: '3' })
    expect(mode).toBe('wal')
    expect(blobColumns).toEqual(['sha', 'size', 'encoding', 'data', 'created_at', 'touched_at'])
  })

  it('AC-004 waits for a busy database instead of failing at once', () => {
    const pragma = vi.spyOn(Database.prototype, 'pragma')
    try {
      sqliteArchive({ file: fileOf() }).close()
      expect(pragma).toHaveBeenCalledWith('busy_timeout = 5000')
    } finally {
      pragma.mockRestore()
    }
  })

  it.each(['1', '2', '99'])(
    'AC-003 refuses a file whose schema version is %s instead of migrating it',
    (version) => {
      const file = fileOf()
      sqliteArchive({ file }).close()
      const db = new Database(file)
      db.exec(`UPDATE meta SET value = '${version}' WHERE key = 'schema_version'`)
      db.close()
      expect(() => sqliteArchive({ file })).toThrow(`表结构版本 ${version} 与本版本的 3 不一致`)
    },
  )

  it('AC-005 updates the summary as the run progresses', async () => {
    const file = fileOf()
    const store = sqliteArchive({ file })
    const events = run('r1', 1000, 'env', { cost: 0.5 })
    await store.append('r1', events.slice(0, 1))
    expect(await store.query({})).toEqual([expect.objectContaining({ runId: 'r1', steps: 0 })])
    await store.append('r1', events.slice(1, 5))
    expect((await store.query({}))[0]).toMatchObject({ steps: 1, toolCalls: 0 })
    expect((await store.query({}))[0]).not.toHaveProperty('status')
    await store.append('r1', events.slice(5))
    expect((await store.query({}))[0]).toMatchObject({
      status: 'completed',
      cost: 0.5,
      endedAt: events[5]!.at,
    })
    expect((await store.query({}))[0]!.usage.main).toEqual(usage(30, 4))
    store.close()
    const db = new Database(file, { readonly: true })
    const row = db.prepare('SELECT input_tokens, output_tokens, status, steps FROM runs').get()
    db.close()
    expect(row).toEqual({ input_tokens: 30, output_tokens: 4, status: 'completed', steps: 1 })
  })

  it('AC-005 filters and limits queries', async () => {
    const store = sqliteArchive({ file: fileOf() })
    await store.append('a', run('a', 1000, 'interactive'))
    await store.append('b', run('b', 2000, 'background'))
    await store.append('c', [...sequence([runStarted({ rootRunId: 'a', parentRunId: 'a' })], 3000)])
    expect((await store.query({ environment: 'background' })).map((s) => s.runId)).toEqual(['b'])
    expect((await store.query({ parentRunId: 'a' })).map((s) => s.runId)).toEqual(['c'])
    expect(
      (await store.query({ startedAfter: 1500, startedBefore: 2500 })).map((s) => s.runId),
    ).toEqual(['b'])
    expect((await store.query({ limit: 2 })).map((s) => s.runId)).toEqual(['c', 'b'])
    expect(
      (await store.query({ status: 'completed', agentId: 'agent' })).map((s) => s.runId),
    ).toEqual(['b', 'a'])
    expect(await store.query({ rootRunId: 'zzz' })).toEqual([])
    store.close()
  })

  it('AC-006 removes only expired, unpinned runs and blobs nobody references', async () => {
    const clock = new FakeClock(1 * DAY)
    const store = sqliteArchive({ file: fileOf(), clock })
    const shared = await store.putBlob('shared')
    const lonely = await store.putBlob('lonely')
    const withBlob = (runId: string, at: number, environment: string, ref: string) =>
      sequence(
        [
          ...run(runId, at, environment).slice(0, 2),
          toolFinished('c1', ref),
          ...run(runId, at, environment).slice(2),
        ],
        at,
      )
    await store.append('old', withBlob('old', 1 * DAY, 'background', lonely))
    await store.append('old-shared', withBlob('old-shared', 1 * DAY, 'background', shared))
    await store.append('kept', withBlob('kept', 1 * DAY, 'background', shared))
    await store.append('long', run('long', 1 * DAY, 'interactive'))
    await store.pin('kept', 'audit')
    await clock.tick(39 * DAY)
    const report = await store.retain({
      defaultDays: 30,
      environments: { interactive: 90 },
      now: 40 * DAY,
    })
    expect(report).toEqual({ removedRuns: 2, removedBlobs: 1 })
    expect((await store.query({})).map((s) => s.runId).sort()).toEqual(['kept', 'long'])
    await expect(store.getBlob(lonely)).rejects.toThrow('blob 不存在')
    expect(await store.getBlob(shared)).toBe('shared')
    expect(await readAll(store, 'old')).toEqual([])
    await expect(store.pin('missing', 'x')).rejects.toThrow('运行不存在')
    store.close()
  })

  it('AC-006 keeps blobs written recently: a running run may have deduplicated against them', async () => {
    const clock = new FakeClock(1 * DAY)
    const store = sqliteArchive({ file: fileOf(), clock })
    const shared = await store.putBlob('shared')
    await store.append(
      'old',
      sequence(
        [
          ...run('old', 1 * DAY).slice(0, 2),
          toolFinished('c1', shared),
          ...run('old', 1 * DAY).slice(2),
        ],
        1 * DAY,
      ),
    )
    await clock.tick(39 * DAY)
    // 运行中的运行刚去重拿到同一个引用，事件还没写入。
    expect(await store.putBlob('shared')).toBe(shared)
    expect(await store.retain({ defaultDays: 30, now: 40 * DAY })).toEqual({
      removedRuns: 1,
      removedBlobs: 0,
    })
    expect(await store.getBlob(shared)).toBe('shared')
    store.close()
  })

  it('AC-007 applies the retention policy when opened', async () => {
    const file = fileOf()
    const first = sqliteArchive({ file })
    await first.append('ancient', run('ancient', 1000))
    first.close()
    const again = sqliteArchive({ file, retention: { defaultDays: 1 } })
    expect(await again.query({})).toEqual([])
    again.close()
  })

  it('keeps runs that never started out of the summary table', async () => {
    const store = sqliteArchive({ file: fileOf() })
    const events = sequence([runEnded({ runId: 'x', status: 'failed', code: 'invalid_agent' })])
    await store.append('x', events)
    expect(await store.query({})).toEqual([])
    expect(await readAll(store, 'x')).toEqual(events)
    store.close()
  })
})
