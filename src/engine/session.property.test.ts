// 会话的属性测试（会话方案 §17）：随机轮数、随机的压缩位置（落在成对边界上）、随机分叉，固定种子。
// 每组跑完后：每一轮冻结的窗口都成对；I17 成立；台账含所有分支执行过的副作用。

import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../contracts/common.js'
import type { Memory } from '../contracts/component.js'
import type { RunEvent } from '../contracts/events.js'
import { parseCanonical } from '../core/definition/hash.js'
import { seededRandom } from '../core/run/random.js'
import { checkPairs } from '../executor/compose/compose-view.js'
import { memoryArchive } from '../services/memory-archive.js'
import { sessionLogIssues } from '../services/session-log.js'
import { FakeClock } from '../testing/fake-clock.js'
import { fakeModel, type FakeReply } from '../testing/fake-model.js'
import { fakeTool } from '../testing/fake-tool.js'
import { assembleEngine } from './engine.js'
import { agentOf, defaults, hubOf, taskOf } from './engine.fixture.js'

/** 随机推进压缩：每一步以 40% 的概率把切点往后挪到一个成对边界上。 */
function randomMemory(random: () => number): Memory {
  return {
    id: 'random-compaction',
    version: '1',
    start: () => {
      let current: { upTo: number; summary: string } | undefined
      return {
        recall: async (s) => {
          const all = [...s.history, ...s.transcript]
          const from = (current?.upTo ?? 0) + 1
          const cuts = Array.from(
            { length: Math.max(0, all.length - from + 1) },
            (_, i) => from + i,
          )
            // 切点不能落在工具结果上（会和它的调用分开）。
            .filter((i) => all[i]?.role !== 'tool')
          if (cuts.length > 0 && random() < 0.4) {
            const upTo = cuts[Math.floor(random() * cuts.length)]!
            current = { upTo, summary: `前 ${upTo} 条的摘要` }
          }
          return current ? { compaction: current } : {}
        },
      }
    },
  }
}

async function playSession(seed: number) {
  const random = seededRandom(seed)
  const clock = new FakeClock()
  let calls = 0
  let id = 0
  const reply = (): FakeReply => {
    if (calls <= 0) return { text: '答复' }
    calls -= 1
    const name = random() < 0.5 ? 'send' : 'search'
    return { toolCalls: [{ id: `c${++id}`, name, input: { n: id } }] }
  }
  const model = fakeModel({ model: 'main', clock, replies: [reply], repeatLast: true })
  const archive = memoryArchive({ clock })
  const engine = assembleEngine(
    { services: { models: hubOf([model.port], { defaultModel: 'fake:main' }), clock, archive } },
    { ...defaults(), memory: randomMemory(random), guards: [], logger: { log: () => {} } },
  )
  const env = engine.environment({ name: 'chat', principal: { reachable: true } })
  const send = fakeTool({ name: 'send', effect: 'side_effect', result: '已发出' })
  const search = fakeTool({ name: 'search', effect: 'none', result: '结果' })
  const agent = agentOf({
    capabilities: [
      {
        id: 'core',
        version: '1',
        kind: 'tool',
        prepare: async () => ({ tools: [send, search], snapshot: { fingerprint: 'fp' } }),
      },
    ],
  })
  const turns: string[] = []
  const count = 2 + Math.floor(random() * 5)
  for (let t = 0; t < count; t++) {
    calls = Math.floor(random() * 4)
    const r = random()
    const continues =
      turns.length === 0 || r < 0.6
        ? undefined
        : r < 0.85
          ? turns[Math.floor(random() * turns.length)]!
          : null
    const run = env.start(
      agent,
      taskOf({ input: [{ role: 'user', parts: [{ type: 'text', text: `第 ${t + 1} 问` }] }] }),
      {
        session: 's',
        ...(continues !== undefined ? { continues } : {}),
      },
    )
    await run.result
    turns.push(run.runId)
  }
  return { engine, archive, turns, send }
}

const read = async (archive: ReturnType<typeof memoryArchive>, runId: string) => {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}

describe('sessions under random compaction and forks', () => {
  it.each(Array.from({ length: 20 }, (_, i) => i + 1))(
    'AC-017 keeps every window paired, I17 intact and every side effect in the ledger (seed %i)',
    async (seed) => {
      const { engine, archive, turns, send } = await playSession(seed)
      expect(await sessionLogIssues(archive, 's')).toEqual([])
      for (const runId of turns) {
        const started = (await read(archive, runId)).find(
          (e): e is Extract<RunEvent, { t: 'run_started' }> => e.t === 'run_started',
        )!
        const content = parseCanonical((await archive.getBlob(started.task.content)) as string) as {
          history: ModelMessage[]
        }
        expect(checkPairs(content.history)).toEqual([])
      }
      const preview = await engine.previewWindow({ session: 's' })
      expect(preview.ok && preview.ledger.length).toBe(send.calls.length)
    },
  )
})
