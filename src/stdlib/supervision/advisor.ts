// 顾问（docs/guard-mechanism.md §3.2 守卫 10）：可选的守卫，在纠偏后仍出问题、或周期检查发现异常时
// 调一次模型做语义诊断。只告知与封路、不终止；每次运行最多调用 maxCalls 次、间隔 ≥ 3 步；
// 置信度 ≥ 0.5、封住的调用在窗口内（意图工具与轮询类工具不封）、建议没有给过才采纳。
// 委托人引导会让守卫重新开始，调用次数与给过的建议按运行记，不随之清零。

import { z } from 'zod'
import type {
  CallBlock,
  Guard,
  GuardOpinion,
  RunInfo,
  StepFacts,
} from '../../contracts/component.js'
import type { ModelRef } from '../../contracts/model.js'

export interface AdvisorOptions {
  /** 不指定时使用运行的模型。 */
  model?: ModelRef
  /** 每次运行最多调用几次，默认 3。 */
  maxCalls?: number
  /** 周期检查的步数间隔，默认 5。 */
  every?: number
  maxOutputTokens?: number
}

const WINDOW_STEPS = 10
const MIN_INTERVAL = 3
const MIN_CONFIDENCE = 0.5
const TASK_CHARS = 1500
const ITEM_CHARS = 200
const REASON_CHARS = 100
/** 周期检查的异常线：失败率、平均文本长度、同名连续调用次数。 */
const FAILURE_RATE = 0.3
const MIN_AVG_TEXT = 50
const SAME_TOOL_RUN = 3

const ADVICE = z.object({
  problem: z.string().min(1),
  suggest: z.string().min(1),
  block: z.array(z.object({ tool: z.string(), inputHash: z.string() })).optional(),
  confidence: z.number().min(0).max(1),
})
type Advice = z.infer<typeof ADVICE>

const SYSTEM = [
  '你是 agent 运行的顾问。根据任务和最近的轨迹，判断运行卡在哪里、下一步怎么做。',
  '只输出一个 JSON 对象，字段：problem（卡住的原因，一句话）、suggest（给 agent 的一条具体建议）、block（可选，需要封住的调用：{ tool, inputHash }）、confidence（0 到 1）。',
].join('\n')

const steeredAt = (facts: StepFacts | undefined): boolean =>
  facts?.interventions.applied.some((a) => a.kind === 'hint' && a.source === 'steering') ?? false

/** 最近 every 步异常：失败率高、文本少，或同名工具连续调用。 */
function unhealthy(recent: readonly StepFacts[]): boolean {
  const calls = recent.flatMap((s) => s.toolCalls)
  const failureRate = calls.length === 0 ? 0 : calls.filter((c) => !c.ok).length / calls.length
  const avgText = recent.reduce((n, s) => n + s.text.length, 0) / recent.length
  let run = 0
  let longest = 0
  calls.forEach((c, i) => {
    run = i > 0 && calls[i - 1]!.name === c.name ? run + 1 : 1
    longest = Math.max(longest, run)
  })
  return failureRate > FAILURE_RATE || avgText < MIN_AVG_TEXT || longest >= SAME_TOOL_RUN
}

function parse(text: string): Advice | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = ADVICE.safeParse(JSON.parse(text.slice(start, end + 1)))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function modelAdvisor(opts: AdvisorOptions = {}): Guard {
  const maxCalls = opts.maxCalls ?? 3
  const every = opts.every ?? 5
  const maxOutputTokens = opts.maxOutputTokens ?? 1024
  /** 按运行记的用量：同一次运行重新 start 时沿用。 */
  const perRun = new WeakMap<RunInfo, { calls: number; lastCall: number; given: Set<string> }>()
  return {
    id: 'advisor',
    version: '1',
    config: { model: opts.model ?? null, maxCalls, every, maxOutputTokens },
    start(run, ctx) {
      const window: StepFacts[] = []
      const usage = perRun.get(run) ?? { calls: 0, lastCall: -Infinity, given: new Set<string>() }
      perRun.set(run, usage)
      return {
        async check(facts): Promise<GuardOpinion | undefined> {
          window.push(facts)
          if (window.length > WINDOW_STEPS) window.shift()
          const counted = facts.toolCalls.filter((c) => !c.repeatable)
          const troubled =
            facts.allToolsFailed === true || (counted.length > 0 && !facts.newInformation)
          const steered = steeredAt(facts) || steeredAt(window.at(-2))
          const periodic = facts.step % every === 0 && unhealthy(window.slice(-every))
          if (!((steered && troubled) || periodic)) return undefined
          if (usage.calls >= maxCalls || facts.step - usage.lastCall < MIN_INTERVAL) {
            return undefined
          }
          usage.calls += 1
          usage.lastCall = facts.step

          const input = {
            task: (run.task.goal ?? run.task.input ?? '').slice(0, TASK_CHARS),
            trajectory: window.map((s) => ({
              step: s.step,
              text: s.text.slice(0, ITEM_CHARS),
              tools: s.toolCalls.map((c) => ({
                name: c.name,
                inputHash: c.inputHash,
                input: (c.inputPreview ?? '').slice(0, ITEM_CHARS),
                ok: c.ok,
                ...(c.errorCode !== undefined ? { errorCode: c.errorCode } : {}),
                output: (c.outputPreview ?? '').slice(0, ITEM_CHARS),
              })),
            })),
          }
          const response = await ctx.callModel({
            purpose: 'supervision:advise',
            system: SYSTEM,
            messages: [{ role: 'user', content: JSON.stringify(input) }],
            maxOutputTokens,
            ...(opts.model ? { model: opts.model } : {}),
          })
          const advice = response ? parse(response.text) : undefined
          if (!advice || advice.confidence < MIN_CONFIDENCE || usage.given.has(advice.suggest)) {
            return undefined
          }
          // 意图工具在交付退回后会以相同输入再调，轮询类工具本来就重复调用：都不封。
          const seen = window
            .flatMap((s) => s.toolCalls)
            .filter((c) => !c.intentTool && !c.repeatable)
          const block = advice.block ?? []
          if (
            !block.every((b) => seen.some((c) => c.name === b.tool && c.inputHash === b.inputHash))
          ) {
            return undefined
          }
          usage.given.add(advice.suggest)
          const blocks: CallBlock[] = block.map((b) => ({
            tool: b.tool,
            inputHash: b.inputHash,
            code: 'repeat',
            reason: `顾问判断：${advice.problem}`.slice(0, REASON_CHARS),
            suggest: advice.suggest,
          }))
          return {
            warn: {
              problem: advice.problem,
              suggest: advice.suggest,
              ...(blocks.length > 0 ? { block: blocks } : {}),
            },
            detail: '顾问',
          }
        },
      }
    },
  }
}
