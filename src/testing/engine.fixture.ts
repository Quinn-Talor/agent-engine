// 测试工具自身的测试数据：只用公开 API 装配的最小引擎。只在测试中使用，不进构建与覆盖率。

import {
  assembleEngine,
  defineAgent,
  defineTask,
  memoryArchive,
  modelHub,
  type ArchiveStore,
  type EngineDefaults,
  type ModelHubOptions,
  type ModelProvider,
} from '../api.js'
import { fakeModel, type FakeReply } from './fake-model.js'
import { fakeTool } from './fake-tool.js'

export const testDefaults = (): EngineDefaults => ({
  memory: {
    id: 'pass',
    version: '1',
    start: () => ({ recall: async (s) => ({ history: s.history, transcript: s.transcript }) }),
  },
  guards: [],
  deliverable: {
    output: {
      id: 'plain',
      version: '1',
      kind: 'text',
      validate: async (c) =>
        (c.text ?? '').trim()
          ? { ok: true }
          : { ok: false, issues: ['交付文本为空'], hint: '请给出回答' },
    },
    fallback: {
      instructions: { '*': { reachable: '说明进展', unreachable: '报告进展' } },
      fixedText: '任务未能完成',
    },
  },
  exposure: {
    id: 'all',
    version: '1',
    start: () => ({ visible: (s) => s.prepared.map((p) => p.name) }),
  },
  logger: { log: () => {} },
})

/** 一个带 lookup 工具的助手；提供方与档案可以被包装（故障注入），模型库可以换时钟与超时。 */
export function testHarness(opts: {
  replies: FakeReply[]
  wrapProvider?: (p: ModelProvider) => ModelProvider
  wrapArchive?: (a: ArchiveStore) => ArchiveStore
  hub?: Pick<ModelHubOptions, 'clock' | 'timeouts'>
}) {
  const model = fakeModel({ model: 'main', replies: opts.replies })
  const archive = memoryArchive()
  const provider = opts.wrapProvider ? opts.wrapProvider(model) : model
  const engine = assembleEngine(
    {
      services: {
        models: modelHub({ ...opts.hub, providers: [provider], default: model.ref }),
        archive: opts.wrapArchive ? opts.wrapArchive(archive) : archive,
      },
    },
    testDefaults(),
  )
  const env = engine.environment({ name: 'test', principal: { reachable: true } })
  const lookup = fakeTool({ name: 'lookup', result: '东京 晴' })
  const agent = defineAgent({
    id: 'helper',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是助手' }] }],
    capabilities: [
      {
        id: 'core',
        version: '1',
        kind: 'tool',
        prepare: async () => ({ tools: [lookup], snapshot: { fingerprint: 'fp' } }),
      },
    ],
  })
  const task = defineTask({
    input: [{ role: 'user', parts: [{ type: 'text', text: '东京天气' }] }],
  })
  return { archive, model, start: () => env.start(agent, task) }
}

export const twoSteps: FakeReply[] = [
  { toolCalls: [{ id: 'c1', name: 'lookup', input: { q: '东京' } }] },
  { text: '东京今天晴。' },
]
