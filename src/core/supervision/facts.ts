// ④ 观察（设计 §3.8）：只产生事实，不调用模型，可以从日志随时重算。

import type { StepFacts, StepToolFact } from '../../contracts/component.js'
import type { ModelPrice, NormalizedUsage } from '../../contracts/model.js'
import { classifyError, possiblyExecuted } from './error-class.js'
import { inputHash } from '../definition/hash.js'
import { addUsage, emptyUsage, type ActiveBlock, type RunState } from '../run/state.js'

/** 费用：价格单位为美元 / 百万 token。价格表没写缓存价时按输入价计，宁可高估也不漏算。 */
export function costOf(usage: NormalizedUsage, price?: ModelPrice): number {
  if (!price) return 0
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * (price.cacheRead ?? price.input) +
      usage.cacheWrite * (price.cacheWrite ?? price.input)) /
    1_000_000
  )
}

/** 计入 maxInputTokens 的输入：全部输入 = 未命中缓存 + 缓存读 + 缓存写。 */
export const inputTokens = (usage: NormalizedUsage): number =>
  usage.input + usage.cacheRead + usage.cacheWrite

/** 主模型、记忆与监督的费用，加上子运行上报的费用。 */
export function runCost(state: RunState, price?: ModelPrice): number {
  const own = [state.usage.main, state.usage.memory, state.usage.supervision].reduce(
    addUsage,
    emptyUsage(),
  )
  return costOf(own, price) + state.childCost
}

const stripSha = (ref: string): string => (ref.startsWith('sha256:') ? ref.slice(7) : ref)

/** 封路按调用匹配：工具名与输入哈希都相同。 */
export function matchBlock(
  blocks: readonly ActiveBlock[],
  step: number,
  tool: string,
  hash: string,
): ActiveBlock | undefined {
  return blocks.find(
    (b) => b.since <= step && b.until >= step && b.tool === tool && b.inputHash === hash,
  )
}

const PREVIEW_CHARS = 200

const timePressure = (elapsed: number, usable: number): number =>
  usable > 0 ? elapsed / usable : 1

export function stepFacts(
  state: RunState,
  opts: { now: number; price?: ModelPrice; previews?: ReadonlyMap<string, string> },
): StepFacts {
  const response = state.response
  const calls = response?.toolCalls ?? []
  const toolCalls: StepToolFact[] = calls.map((c) => {
    const r = state.results[c.id]
    const fact: StepToolFact = {
      name: c.name,
      capability: r?.capability ?? state.tools[c.name]?.capability ?? '',
      inputHash: inputHash(c.input),
      outputHash: r ? stripSha(r.shown) : '',
      ok: r ? !r.isError : false,
      effect: r?.effect ?? state.tools[c.name]?.effect ?? 'side_effect',
      durationMs: r?.durationMs ?? 0,
      blocked: r?.errorCode === 'TOOL_BLOCKED',
    }
    if (r?.errorCode !== undefined) fact.errorCode = r.errorCode
    if (!fact.ok) fact.errorClass = r?.errorClass ?? classifyError(r?.errorCode ?? '')
    if (r && possiblyExecuted(r)) fact.possiblyExecuted = true
    fact.inputPreview = (JSON.stringify(c.input ?? null) ?? '').slice(0, PREVIEW_CHARS)
    const preview = opts.previews?.get(c.id)
    if (preview !== undefined) fact.outputPreview = preview.slice(0, PREVIEW_CHARS)
    if (state.tools[c.name]?.repeatable === true) fact.repeatable = true
    if (state.tools[c.name]?.intent !== undefined) fact.intentTool = true
    return fact
  })

  const intents = toolCalls.filter((c) => c.ok && state.tools[c.name]?.intent)
  const intentMeta = intents.length === 1 ? state.tools[intents[0]!.name]!.intent! : undefined
  const intent = intentMeta
    ? { tool: intents[0]!.name, kind: intentMeta.kind, code: intentMeta.code }
    : undefined

  const seen = new Set(state.seenOutputs)
  const step = state.step
  const applied: StepFacts['interventions']['applied'] = []
  for (const e of state.transcript) {
    if (e.origin === 'hint' && e.step === step) applied.push({ kind: 'hint', source: e.source })
  }
  for (const b of state.blocks) {
    if (b.since === step) applied.push({ kind: 'block', source: b.source })
  }
  if (state.transcript.some((e) => e.origin === 'steer' && e.step === step)) {
    applied.push({ kind: 'steer', source: 'principal' })
  }
  const violated = toolCalls
    .filter((c) => c.blocked)
    .map((c) => matchBlock(state.blocks, step, c.name, c.inputHash))
    .filter((b): b is ActiveBlock => b !== undefined)
    .map((b) => ({ source: b.source, code: b.code }))

  const { budget, usage } = state

  const facts: StepFacts = {
    step,
    text: response?.text ?? '',
    toolCalls,
    allToolsFailed: toolCalls.length === 0 ? null : toolCalls.every((c) => !c.ok),
    // 截断的纯文本步不是候选：完成排在收尾之前，截断文本不能当成完成。
    // 被收尾预留线截断的回复也不是。
    isFinalCandidate:
      !state.deadlineCut &&
      ((toolCalls.length === 0 && response?.finishReason !== 'length') ||
        (toolCalls.length === 1 && intent?.kind === 'complete')),
    newInformation: toolCalls.some((c) => c.outputHash !== '' && !seen.has(c.outputHash)),
    finishReason: response?.finishReason ?? 'other',
    interventions: { applied, violated },
    pressure: {
      context: Number.isFinite(state.inputLimit) ? state.lastEstimate / state.inputLimit : 0,
      steps: step / budget.maxSteps,
      // 按收尾预留之前的可用时长算：到 1 时 decide 以 timeout 收尾。
      time:
        budget.maxTotalMs !== undefined && state.startedAt !== undefined
          ? timePressure(opts.now - state.startedAt, budget.maxTotalMs - budget.finalizeReserveMs)
          : 0,
      cost:
        budget.maxCost !== undefined && opts.price
          ? runCost(state, opts.price) / budget.maxCost
          : 0,
      tokens: budget.maxInputTokens !== undefined ? inputTokens(usage) / budget.maxInputTokens : 0,
    },
    stepsLeft: budget.maxSteps - step,
    usage: response?.usage ?? emptyUsage(),
  }
  if (intent) facts.intent = intent
  return facts
}
