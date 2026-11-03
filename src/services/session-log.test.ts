import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../contracts/events.js'
import { canonicalJson } from '../core/definition/hash.js'
import {
  call,
  contextBuilt,
  modelResponded,
  runEnded,
  runStarted,
  sequence,
  stepStarted,
  toolFinished,
  toolSnapshot,
  type EventBody,
} from '../core/log/events.fixture.js'
import { memoryArchive } from './memory-archive.js'
import { deriveWindow } from './session-log.js'

const tools = [
  {
    capability: 'tools',
    kind: 'tool' as const,
    version: '1',
    fingerprint: 'fp',
    tools: [toolSnapshot('send', { effect: 'side_effect' })],
  },
]

describe('deriveWindow', () => {
  it('AC-013 lists the side effects of child runs in a fixed order: by start time, then run id', async () => {
    const archive = memoryArchive()
    const content = await archive.putBlob(canonicalJson({ input: [], history: [] }))
    const turn = sequence([
      runStarted({
        task: { fingerprint: 't', content },
        capabilities: tools,
        rootRunId: 'turn-1',
        session: {
          id: 's',
          turn: 1,
          window: { version: 1, turnStarts: [], ledger: [], tokens: 0 },
        },
      }),
      stepStarted(1),
      contextBuilt(1),
      runEnded({ runId: 'turn-1' }),
    ])
    await archive.append('turn-1', turn)
    // 三个子运行：两个在同一毫秒开始，档案按开始时间倒序返回它们。
    const child = (runId: string, startAt: number, to: string): RunEvent[] => {
      const bodies: EventBody[] = [
        runStarted({ capabilities: tools, rootRunId: 'turn-1', parentRunId: 'turn-1' }),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { toolCalls: [call(`${runId}-c`, 'send', { to })] }),
        toolFinished(`${runId}-c`, { effect: 'side_effect' }),
        runEnded({ runId }),
      ]
      return sequence(bodies, startAt)
    }
    await archive.append('child-b', child('child-b', 2_000, 'b'))
    await archive.append('child-a', child('child-a', 2_000, 'a'))
    await archive.append('child-z', child('child-z', 1_500, 'z'))
    const order = async () => {
      const r = await deriveWindow(archive, { session: 's' })
      if (!r.ok) throw new Error(r.message)
      return r.derived.ledger.map((e) => e.input)
    }
    expect(await order()).toEqual(['{"to":"z"}', '{"to":"a"}', '{"to":"b"}'])
    expect(await order()).toEqual(await order())
  })
})
