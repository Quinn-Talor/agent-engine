import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  call,
  contextBuilt,
  modelResponded,
  runStarted,
  sequence,
  stepStarted,
  toolSnapshot,
} from '../../../src/core/events.fixture.js'
import {
  createEngine,
  defineAgent,
  defineTask,
  fakeModel,
  modelHub,
  sqliteArchive,
  type RunEvent,
} from '../../../src/index.js'

const quiet = { log: () => {} }
const dirs: string[] = []
const fileOf = () => {
  const dir = mkdtempSync(join(tmpdir(), 'persist-'))
  dirs.push(dir)
  return join(dir, 'runs.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const readAll = async (archive: ReturnType<typeof sqliteArchive>, runId: string) => {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}

describe('persistence on SQLite', () => {
  it('AC-008 closes a run interrupted by a previous process', async () => {
    const file = fileOf()
    const before = sqliteArchive({ file })
    const tools = [
      {
        capability: 'tools',
        kind: 'tool',
        version: '1',
        fingerprint: 'fp',
        tools: [toolSnapshot('search', { effect: 'side_effect' })],
      },
    ]
    await before.append(
      'crashed',
      sequence([
        runStarted({ rootRunId: 'crashed', capabilities: tools }),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { toolCalls: [call('c1')] }),
      ]),
    )
    before.close()

    const archive = sqliteArchive({ file })
    const engine = createEngine({
      services: { models: modelHub({ providers: [] }), archive, logger: quiet },
    })
    expect(await engine.interrupted()).toEqual([
      expect.objectContaining({ runId: 'crashed', status: 'aborted', code: 'interrupted' }),
    ])
    archive.close()

    const after = sqliteArchive({ file })
    const events = await readAll(after, 'crashed')
    expect(events.slice(-2).map((e) => [e.t, e.seq])).toEqual([
      ['tool_finished', 5],
      ['run_ended', 6],
    ])
    expect(events[4]).toMatchObject({ errorCode: 'TOOL_INTERRUPTED', effect: 'side_effect' })
    expect(
      await createEngine({
        services: { models: modelHub({ providers: [] }), archive: after, logger: quiet },
      }).interrupted(),
    ).toEqual([])
    after.close()
  })

  it('AC-009 persists a complete run', async () => {
    const file = fileOf()
    const archive = sqliteArchive({ file })
    const model = fakeModel({ model: 'main', replies: [{ text: '已保存' }] })
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        logger: quiet,
      },
    })
    const agent = defineAgent({
      id: 'helper',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '助手' }] }],
    })
    const task = defineTask({
      input: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      subject: 's-1',
    })
    const run = engine.environment({ name: 'i', principal: { reachable: true } }).start(agent, task)
    await run.result
    archive.close()

    const reopened = sqliteArchive({ file })
    expect(await reopened.query({ subject: 's-1' })).toEqual([
      expect.objectContaining({ runId: run.runId, status: 'completed', agentId: 'helper' }),
    ])
    expect((await readAll(reopened, run.runId)).at(-1)).toMatchObject({ t: 'run_ended' })
    reopened.close()
  })
})
