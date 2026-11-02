// F25：依赖环境状态的封路在写操作成功后解除——改完代码可以原样重跑；没有改动时重跑仍撞上封路。
import { describe, expect, it } from 'vitest'
import {
  createEngine,
  defineAgent,
  defineTask,
  memoryArchive,
  modelHub,
  tools,
} from '../../../src/index.js'
import { fakeModel, fakeTool } from '../../../src/testing.js'

const quiet = { log: () => {} }
type Replies = Parameters<typeof fakeModel>[0]['replies']

async function runWith(replies: Replies) {
  let runs = 0
  const run = fakeTool({
    name: 'run',
    run: () =>
      ++runs === 1
        ? { __agent_error: true, code: 'TOOL_FAILED', message: 'boom', errorClass: 'deterministic' }
        : 'ok',
  })
  const fix = fakeTool({ name: 'fix', effect: 'side_effect', result: 'fixed' })
  const model = fakeModel({ model: 'main', replies })
  const engine = createEngine({
    services: {
      models: modelHub({ providers: [model], default: model.ref }),
      archive: memoryArchive(),
      logger: quiet,
    },
  })
  const agent = defineAgent({
    id: 'coder',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '修好脚本' }] }],
    capabilities: [tools([run, fix])],
  })
  const task = defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '跑通' }] }] })
  const result = await engine
    .environment({ name: 'i', principal: { reachable: true } })
    .start(agent, task).result
  await engine.shutdown()
  return { result, runCalls: run.calls.length }
}

describe('F25 unblock on change', () => {
  it('AC-006 lets the same command run again after a write, and still blocks it without one', async () => {
    const fixed = await runWith([
      { toolCalls: [{ id: 'r1', name: 'run', input: { a: 1 } }] },
      { toolCalls: [{ id: 'f1', name: 'fix', input: {} }] },
      { toolCalls: [{ id: 'r2', name: 'run', input: { a: 1 } }] },
      { text: 'done' },
    ])
    expect(fixed.result.status).toBe('completed')
    expect(fixed.runCalls).toBe(2)

    const unchanged = await runWith([
      { toolCalls: [{ id: 'r1', name: 'run', input: { a: 1 } }] },
      { toolCalls: [{ id: 'r2', name: 'run', input: { a: 1 } }] },
      { text: 'done' },
    ])
    expect(unchanged.result.status).toBe('finalized')
    expect(unchanged.runCalls).toBe(1)
  })
})
