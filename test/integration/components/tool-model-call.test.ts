// 工具经引擎调用模型（设计 §8.2 ToolCtx.callModel）：写进日志、计入用量的 tools 分组（I8）。

import { describe, expect, it } from 'vitest'
import {
  createEngine,
  defineAgent,
  defineTask,
  memoryArchive,
  modelHub,
  tools,
  type RunEvent,
  type ToolDef,
} from '../../../src/index.js'
import { fakeModel } from '../../../src/testing.js'

const sys = { role: 'system' as const, parts: [{ type: 'text' as const, text: '你是助手' }] }
const ask = defineTask({
  input: [{ role: 'user', parts: [{ type: 'text', text: '总结这份材料' }] }],
})

describe('a tool that calls the model', () => {
  it('AC-008 records the call before the tool result and counts it as tool usage', async () => {
    const summarize: ToolDef = {
      name: 'summarize',
      description: '摘要一段材料',
      inputSchema: { type: 'object', properties: {} },
      execution: { effect: 'none' },
      async execute(_input, ctx) {
        const answer = await ctx.callModel({
          purpose: 'digest',
          messages: [{ role: 'user', content: '材料正文' }],
        })
        return answer?.text ?? ''
      },
    }
    const model = fakeModel({
      model: 'main',
      replies: [
        { toolCalls: [{ id: 's1', name: 'summarize', input: {} }] },
        { text: '材料讲的是欠薪', usage: { input: 40, output: 8 } },
        { text: '总结：欠薪纠纷' },
      ],
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        logger: { log: () => {} },
      },
    })
    const agent = defineAgent({
      id: 'helper',
      instructions: [sys],
      capabilities: [tools([summarize])],
    })
    const run = engine
      .environment({ name: 'chat', principal: { reachable: true } })
      .start(agent, ask)
    const result = await run.result
    expect(result).toMatchObject({ status: 'completed', text: '总结：欠薪纠纷' })

    const events: RunEvent[] = []
    for await (const e of archive.read(run.runId)) events.push(e)
    const call = events.findIndex(
      (e) => e.t === 'external_call' && e.source === 'tool:summarize/digest',
    )
    const finished = events.findIndex((e) => e.t === 'tool_finished' && e.callId === 's1')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(finished)
    expect(result.usage.tools).toEqual({ input: 40, output: 8, cacheRead: 0, cacheWrite: 0 })
    expect(result.usage.input).toBeGreaterThanOrEqual(40 + result.usage.main.input)
  })
})
