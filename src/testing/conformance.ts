// 组件一致性测试（设计 §4.3 规约、§13 `conformance.*`）：每类组件一组守约用例——确定性、只收窄、
// 不破坏成对、返回值形状合法、边界输入不抛错。框架无关：返回用例列表，断言用 node:assert/strict。
// 确定性：两个新 start 的实例依次喂同一串输入，输出逐项相同（有状态的组件也适用）。
// 记忆的样本覆盖压缩触发线上下（设计 §11，默认 0.8）与超出窗口；副模型替身返回固定摘要，让记忆真的压缩。

import assert from 'node:assert/strict'
import { canonicalJson, guardOpinionIssue, permitResultIssue } from '../api.js'
import type { ModelMessage } from '../contracts/common.js'
import type {
  Candidate,
  Check,
  ComponentCtx,
  Corpus,
  Exposure,
  Guard,
  GuardOpinion,
  Memory,
  MemoryState,
  MemoryView,
  Observation,
  PermissionRule,
  PermitResult,
  RunInfo,
  StepToolFact,
  ToolboxState,
} from '../contracts/component.js'
import type { SideModelResponse } from '../contracts/model.js'
import type { ToolCallView } from '../contracts/tool.js'
import type { ContractCase } from './archive-contract.js'
import { FakeClock } from './fake-clock.js'

export interface ConformanceOptions {
  /** 覆盖测试替身的组件上下文，例如 hook 组件需要 host('hook')。 */
  ctx?: Partial<ComponentCtx>
  /** 记忆的压缩触发线：（固定占用 + 估算值）/ 模型窗口低于它的样本不得丢消息；缺省 0.8。 */
  trigger?: number
}

const DEFAULT_TRIGGER = 0.8

const RUN: RunInfo = {
  runId: 'conformance-run',
  rootRunId: 'conformance-run',
  environment: { name: 'conformance', principalReachable: true },
  agent: { id: 'conformance-agent' },
  task: { subject: 'conformance', input: '整理东京的天气' },
  model: { ref: 'fake:model', contextLimit: 8000 },
}

function contextOf(opts: ConformanceOptions = {}): ComponentCtx {
  return {
    clock: new FakeClock(),
    random: () => 0.5,
    callModel: async () => undefined,
    record: (_name, fn) => fn(),
    log: () => {},
    host: (kind) => {
      throw new Error(`conformance: 没有能力宿主 ${kind}`)
    },
    ...opts.ctx,
  }
}

// ── 样本 ───────────────────────────────────────────────────────

const fact = (patch: Partial<StepToolFact> = {}): StepToolFact => ({
  name: 'search',
  capability: 'web',
  inputHash: 'in-1',
  outputHash: 'out-1',
  ok: true,
  effect: 'none',
  durationMs: 10,
  blocked: false,
  ...patch,
})

function observation(step: number, patch: Partial<Observation> = {}): Observation {
  const toolCalls = patch.toolCalls ?? []
  return {
    step,
    text: '',
    toolCalls,
    allToolsFailed: toolCalls.length === 0 ? null : toolCalls.every((c) => !c.ok),
    isFinalCandidate: toolCalls.length === 0,
    newInformation: true,
    finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
    interventions: { applied: [], violated: [] },
    pressure: { context: 0, steps: 0, time: 0, tokens: 0, cost: 0 },
    stepsLeft: 10,
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    ...patch,
  }
}

const failedCall = (i: number) =>
  fact({ ok: false, errorCode: 'TOOL_EXCEPTION', inputHash: `in-${i}`, outputHash: `err-${i}` })

/** 空步、全部失败的步、重复调用的步、带干预的步、文本回答。 */
const SAMPLE_STEPS: Array<Partial<Observation>> = [
  {},
  { toolCalls: [failedCall(1), failedCall(2)] },
  { toolCalls: [fact(), fact()], newInformation: false },
  {
    toolCalls: [fact({ blocked: true, ok: false, errorCode: 'TOOL_BLOCKED' })],
    interventions: {
      applied: [{ kind: 'hint', source: 'steering' }],
      violated: [{ source: 'engine:roadblock', code: 'repeat' }],
    },
    pressure: { context: 0.9, steps: 0.9, time: 0.9, tokens: 0, cost: 0 },
    stepsLeft: 1,
  },
  { text: '东京今天晴，20 度。', isFinalCandidate: true },
]

/** 依次喂给有状态组件的事实序列：重复失败 8 步，再给一个文本回答。 */
function failingSequence(): Observation[] {
  const failing = Array.from({ length: 8 }, (_, i) =>
    observation(i + 1, { toolCalls: [failedCall(1)], newInformation: false }),
  )
  return [...failing, observation(9, { text: '东京今天晴。', isFinalCandidate: true })]
}

/** 10 个健康步：调用成功、有新信息、有文本说明进展。 */
function healthySequence(): Observation[] {
  return Array.from({ length: 10 }, (_, i) =>
    observation(i + 1, {
      text: `已查到第 ${i + 1} 个城市的天气。`,
      toolCalls: [fact({ inputHash: `in-h${i}`, outputHash: `out-h${i}` })],
      newInformation: true,
      finishReason: 'stop',
    }),
  )
}

const toolCall = (id: string, name = 'search'): ModelMessage => ({
  role: 'assistant',
  content: [
    { type: 'text', text: `查询 ${id}` },
    { type: 'tool-call', toolCallId: id, toolName: name, input: { q: id } },
  ],
})
const toolResult = (id: string, output: string, name = 'search'): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: name, output }],
})

const estimate = (messages: ModelMessage[]) =>
  Math.ceil(messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0) / 4)

/** 视图占比：（固定占用 + 估算值）/ 模型窗口，与压缩触发线比较。 */
const ratioOf = (s: MemoryState) =>
  (s.fixedTokens + s.estimate([...s.history, ...s.transcript])) / s.contextLimit

const exchanges = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => [
    toolCall(`${prefix}${i}`),
    toolResult(`${prefix}${i}`, `东京 第 ${i} 条 ${'数据'.repeat(200)}`),
  ]).flat()

/**
 * 占比依次约为 0.05、0.07、0.48、0.02、0.73（低于默认触发线）；
 * 0.87、0.94（高于触发线，后者切在 history 里）；1.59（超出窗口）。
 */
function memorySamples(): MemoryState[] {
  const history: ModelMessage[] = [
    { role: 'user', content: '上次查过大阪' },
    toolCall('h1'),
    toolResult('h1', '大阪 多云'),
    { role: 'assistant', content: '大阪多云。' },
  ]
  const transcript = exchanges('t', 10)
  const base = { step: 11, contextLimit: 4000, fixedTokens: 200, estimate }
  return [
    { ...base, history: [], transcript: [] },
    { ...base, history, transcript: [] },
    { ...base, history, transcript },
    { ...base, history: [], transcript, contextLimit: 100_000 },
    { ...base, history, transcript, contextLimit: 2_600 },
    { ...base, history, transcript, contextLimit: 2_200 },
    {
      ...base,
      history: [...history, ...exchanges('p', 10)],
      transcript: exchanges('t', 1),
      contextLimit: 2_200,
    },
    { ...base, history, transcript, contextLimit: 1_200 },
  ]
}

/** 压缩用的副模型替身：返回固定摘要（`opts.ctx.callModel` 可以覆盖）。 */
const summarize = async (): Promise<SideModelResponse> => ({
  text: '1. 意图：整理东京的天气\n2. 关键事实：东京晴 20 度',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  model: RUN.model.ref,
})

/** 输入之外的消息只能是声明过的压缩摘要：system 消息，正文含 `compaction.summary`。 */
function isDeclaredSummary(x: ModelMessage, view: MemoryView): boolean {
  const summary = view.compaction?.summary
  return (
    x.role === 'system' &&
    isString(x.content) &&
    isString(summary) &&
    summary.length > 0 &&
    x.content.includes(summary)
  )
}

function toolboxSamples(): ToolboxState[] {
  const prepared: ToolboxState['prepared'] = [
    { name: 'search', capability: 'web', exposure: 'eager', description: '搜索' },
    { name: 'fetch', capability: 'web', exposure: 'deferred', description: '抓取网页' },
    { name: 'search_tool', capability: 'exposure', exposure: 'eager' },
    { name: 'crm__lookup', capability: 'mcp:crm', exposure: 'deferred' },
  ]
  return [
    { step: 1, prepared, calls: [] },
    { step: 2, prepared, calls: [{ step: 1, name: 'search_tool' }] },
    { step: 3, prepared, calls: [{ step: 2, name: 'fetch' }] },
    { step: 1, prepared: prepared.slice(0, 1), calls: [] },
  ]
}

const EMPTY_CORPUS: Corpus = { sources: [] }
const CORPUS: Corpus = {
  sources: [
    { origin: 'input', text: '整理东京的天气' },
    {
      origin: 'tool',
      text: '东京 晴 20 度',
      callId: 'c1',
      toolName: 'weather',
      effect: 'none',
      isError: false,
    },
    {
      origin: 'tool',
      text: '已写入日报',
      callId: 'c2',
      toolName: 'write_report',
      effect: 'side_effect',
      isError: false,
    },
  ],
}

function candidateSamples(): Array<{ candidate: Candidate; corpus: Corpus }> {
  const answer = (text: string, step = 2): Candidate => ({
    step,
    text,
    observation: observation(step, { text, isFinalCandidate: true }),
  })
  return [
    { candidate: answer(''), corpus: EMPTY_CORPUS },
    { candidate: answer('', 1), corpus: CORPUS },
    { candidate: answer('东京今天晴，20 度，已写入日报。'), corpus: CORPUS },
    { candidate: answer('大阪明天下雨，气温 35 度，降水 80%。'), corpus: CORPUS },
    {
      candidate: { step: 1, output: { city: '东京' }, observation: observation(1) },
      corpus: CORPUS,
    },
  ]
}

function callSamples(): ToolCallView[] {
  const base = { capability: 'fs', effect: 'none' as const, risk: 'low' as const }
  return [
    { ...base, callId: 'p1', toolName: 'list', input: {} },
    { ...base, callId: 'p2', toolName: 'read', input: {}, access: { read: ['./notes.md'] } },
    {
      ...base,
      callId: 'p3',
      toolName: 'write',
      input: {},
      effect: 'side_effect',
      risk: 'high',
      access: { write: ['~/.ssh/id_rsa'] },
    },
    {
      ...base,
      callId: 'p4',
      toolName: 'deploy',
      input: { env: 'prod' },
      effect: 'side_effect',
      risk: 'high',
    },
  ]
}

// ── 形状校验 ───────────────────────────────────────────────────

const isString = (v: unknown): v is string => typeof v === 'string'

// 守卫意见与权限结果按引擎运行时的同一套规则检查（core/definition/component-results.ts），两边不会走样。
function assertGuardOpinion(o: GuardOpinion | undefined, label: string) {
  if (o === undefined) return
  const issue = guardOpinionIssue(o)
  assert.ok(issue === undefined, `${label}：${issue}：${canonicalJson(o)}`)
}

function assertPermit(r: PermitResult, label: string) {
  const issue = permitResultIssue(r)
  assert.ok(issue === undefined, `${label}：${issue}：${canonicalJson(r)}`)
}

/** 每个工具调用后紧跟一条 tool 消息，含全部结果；每个结果都有对应的调用。 */
function assertPaired(messages: readonly ModelMessage[], label: string) {
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const ids = m.content.flatMap((p) => (p.type === 'tool-call' ? [p.toolCallId] : []))
      if (ids.length === 0) return
      const next = messages[i + 1]
      const results = next?.role === 'tool' ? next.content.map((p) => p.toolCallId) : []
      for (const id of ids) {
        assert.ok(results.includes(id), `${label}：工具调用 ${id} 后面没有紧跟结果`)
      }
    }
    if (m.role === 'tool') {
      const prev = messages[i - 1]
      const ids =
        prev?.role === 'assistant' && Array.isArray(prev.content)
          ? prev.content.flatMap((p) => (p.type === 'tool-call' ? [p.toolCallId] : []))
          : []
      for (const p of m.content) {
        assert.ok(ids.includes(p.toolCallId), `${label}：工具结果 ${p.toolCallId} 前面没有调用`)
      }
    }
  })
}

const same = (a: unknown, b: unknown, label: string) =>
  assert.equal(canonicalJson(b), canonicalJson(a), `${label}：两次结果不同`)

// ── 各类组件 ───────────────────────────────────────────────────

function guard(g: Guard, opts?: ConformanceOptions): ContractCase[] {
  const run = async (sequence: readonly Observation[]) => {
    const instance = g.start(RUN, contextOf(opts))
    const out: Array<GuardOpinion | undefined> = []
    for (const facts of sequence) out.push(await instance.check(facts))
    return out
  }
  return [
    {
      name: 'guard: returns undefined or a valid opinion',
      async run() {
        for (const [n, patch] of SAMPLE_STEPS.entries()) {
          const [o] = await run([observation(1, patch)])
          assertGuardOpinion(o, `${g.id} 样本 ${n}`)
        }
        for (const [n, o] of (await run(failingSequence())).entries()) {
          assertGuardOpinion(o, `${g.id} 序列 ${n}`)
        }
      },
    },
    {
      name: 'guard: is deterministic',
      async run() {
        same(await run(failingSequence()), await run(failingSequence()), `${g.id} 序列`)
      },
    },
    {
      name: 'guard: does not warn on every healthy step',
      async run() {
        const opinions = (await run(healthySequence())).filter((o) => o !== undefined)
        assert.ok(opinions.length < 10, `${g.id}：10 个健康步给出了 ${opinions.length} 条意见`)
      },
    },
  ]
}

function memory(m: Memory, opts: ConformanceOptions = {}): ContractCase[] {
  const trigger = opts.trigger ?? DEFAULT_TRIGGER
  const ctx = () => contextOf({ ctx: { callModel: summarize, ...opts.ctx } })
  // 每次给一份新的运行信息：记忆改写了它也不会串到别的用例。
  const recall = (s: MemoryState, run: RunInfo = structuredClone(RUN)) =>
    m.start(run, ctx()).recall(s)
  return [
    {
      name: 'memory: is deterministic',
      async run() {
        for (const [n, s] of memorySamples().entries()) {
          same(await recall(s), await recall(s), `${m.id} 样本 ${n}`)
        }
      },
    },
    {
      name: 'memory: keeps tool calls paired with their results',
      async run() {
        for (const [n, s] of memorySamples().entries()) {
          const view = await recall(s)
          assertPaired([...view.history, ...view.transcript], `${m.id} 样本 ${n}`)
        }
      },
    },
    {
      name: 'memory: only shows messages from the history and the transcript',
      async run() {
        for (const [n, s] of memorySamples().entries()) {
          const view = await recall(s)
          const known = new Set([...s.history, ...s.transcript].map((x) => canonicalJson(x)))
          for (const x of [...view.history, ...view.transcript]) {
            assert.ok(
              known.has(canonicalJson(x)) || isDeclaredSummary(x, view),
              `${m.id} 样本 ${n}：视图里有输入之外、也不是已声明摘要的消息 ${canonicalJson(x)}`,
            )
          }
        }
      },
    },
    {
      name: 'memory: keeps every message below the compaction trigger',
      async run() {
        for (const [n, s] of memorySamples().entries()) {
          const ratio = ratioOf(s)
          if (ratio >= trigger) continue
          const view = await recall(s)
          const shown = new Set([...view.history, ...view.transcript].map((x) => canonicalJson(x)))
          const dropped = [...s.history, ...s.transcript]
            .map((x) => canonicalJson(x))
            .filter((x) => !shown.has(x))
          assert.deepEqual(
            dropped,
            [],
            `${m.id} 样本 ${n}：占比 ${ratio.toFixed(2)} 低于压缩触发线 ${trigger}，视图却丢了消息`,
          )
        }
      },
    },
    {
      // 设计 §4.4：记忆不得改写日志里的运行记录、不得动任务输入；压缩只改变视图（I3）。
      name: 'memory: leaves the task input and the given messages untouched',
      async run() {
        for (const [n, s] of memorySamples().entries()) {
          const run = structuredClone(RUN)
          const given = canonicalJson([s.history, s.transcript])
          await recall(s, run)
          assert.equal(
            canonicalJson(run),
            canonicalJson(RUN),
            `${m.id} 样本 ${n}：改写了任务输入或运行信息`,
          )
          assert.equal(
            canonicalJson([s.history, s.transcript]),
            given,
            `${m.id} 样本 ${n}：改写了传入的 history 或运行记录（压缩只能改变视图）`,
          )
        }
      },
    },
    {
      name: 'memory: handles an empty transcript',
      async run() {
        const view = await recall(memorySamples()[0]!)
        assert.ok(Array.isArray(view.history) && Array.isArray(view.transcript))
      },
    },
  ]
}

function exposure(e: Exposure, opts?: ConformanceOptions): ContractCase[] {
  const visible = (s: ToolboxState) => e.start(RUN, contextOf(opts)).visible(s)
  return [
    {
      name: 'exposure: is deterministic',
      async run() {
        for (const [n, s] of toolboxSamples().entries()) {
          same(visible(s), visible(s), `${e.id} 样本 ${n}`)
        }
      },
    },
    {
      name: 'exposure: only narrows the prepared tools',
      async run() {
        for (const [n, s] of toolboxSamples().entries()) {
          const names = new Set(s.prepared.map((p) => p.name))
          const extra = visible(s).filter((v) => !names.has(v))
          assert.deepEqual(extra, [], `${e.id} 样本 ${n}：可见工具超出已准备：${extra.join('、')}`)
        }
      },
    },
    {
      name: 'exposure: shows nothing when nothing is prepared',
      async run() {
        assert.deepEqual(visible({ step: 1, prepared: [], calls: [] }), [])
      },
    },
  ]
}

function check(c: Check, opts?: ConformanceOptions): ContractCase[] {
  const accept = (s: { candidate: Candidate; corpus: Corpus }) =>
    c.start(RUN, contextOf(opts)).accept(s.candidate, s.corpus)
  return [
    {
      name: 'check: returns a valid result',
      async run() {
        for (const [n, s] of candidateSamples().entries()) {
          const r = await accept(s)
          const label = `${c.id} 样本 ${n}`
          if (r.pass) {
            assert.deepEqual(Object.keys(r), ['pass'], `${label}：通过时只有 pass`)
          } else {
            assert.ok(
              Array.isArray(r.issues) && r.issues.every(isString),
              `${label}：issues 必须是字符串数组`,
            )
            assert.ok(isString(r.hint), `${label}：hint 必须是字符串`)
          }
        }
      },
    },
    {
      name: 'check: is deterministic',
      async run() {
        for (const [n, s] of candidateSamples().entries()) {
          same(await accept(s), await accept(s), `${c.id} 样本 ${n}`)
        }
      },
    },
  ]
}

function permission(p: PermissionRule, opts?: ConformanceOptions): ContractCase[] {
  const permit = (call: ToolCallView) => p.permit(call, RUN, contextOf(opts))
  return [
    {
      name: 'permission: returns allow, deny or ask',
      async run() {
        for (const call of callSamples()) assertPermit(await permit(call), `${p.id} ${call.callId}`)
      },
    },
    {
      name: 'permission: is deterministic',
      async run() {
        for (const call of callSamples()) {
          same(await permit(call), await permit(call), `${p.id} ${call.callId}`)
        }
      },
    },
  ]
}

export const conformance: {
  guard(g: Guard, opts?: ConformanceOptions): ContractCase[]
  memory(m: Memory, opts?: ConformanceOptions): ContractCase[]
  exposure(e: Exposure, opts?: ConformanceOptions): ContractCase[]
  check(c: Check, opts?: ConformanceOptions): ContractCase[]
  permission(p: PermissionRule, opts?: ConformanceOptions): ContractCase[]
} = { guard, memory, exposure, check, permission }
