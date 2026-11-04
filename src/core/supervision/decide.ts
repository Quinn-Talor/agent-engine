// ⑥ 判定（设计 §3.10、docs/guard-mechanism.md §3.4）：所有"下一步怎么办"都在这里决定，没有第二个决策点。

import type { Intervention, Observation, Opinion, Verdict } from '../../contracts/component.js'
import type { ModelPrice } from '../../contracts/model.js'
import { inputTokens, runCost } from './facts.js'
import type { RunState, SourcedIntervention } from '../run/state.js'

export interface SourcedOpinion {
  source: string
  opinion: Opinion
}

export interface BudgetState {
  stepsLeft: number
  tokensExhausted: boolean
  costExhausted: boolean
  timeLeftMs?: number
  finalizeReserveMs: number
  structured: boolean
  /** 有已收到、还没生效的委托人引导（下一步组装时生效）。 */
  steerPending?: boolean
}

/** 发现合并上限；纠偏消息整条另有上限（steering.ts）。 */
const MAX_HINT_CHARS = 1200

type Kind = 'stop' | 'finalize' | 'awaitInput' | 'continue' | 'complete'

/**
 * 合并顺序：停止 > 等待输入 > 完成 > 收尾 > 继续。完成排在收尾前：守卫不能阻止完成，
 * 完成只由交付验收判定；撞上封路的收尾来自 `guard:violation`，排在候选之前。
 */
const RANK: Record<Kind, number> = { stop: 5, awaitInput: 4, complete: 3, finalize: 2, continue: 1 }

function kindOf(opinion: Opinion): Kind {
  if ('stop' in opinion) return 'stop'
  if ('finalize' in opinion) return 'finalize'
  if ('awaitInput' in opinion) return 'awaitInput'
  if ('continue' in opinion) return 'continue'
  return 'complete'
}

export function budgetState(
  state: RunState,
  opts: { now: number; price?: ModelPrice; structured: boolean },
): BudgetState {
  const { budget } = state
  const result: BudgetState = {
    stepsLeft: budget.maxSteps - state.step,
    tokensExhausted:
      budget.maxInputTokens !== undefined && inputTokens(state.usage) >= budget.maxInputTokens,
    costExhausted:
      budget.maxCost !== undefined &&
      opts.price !== undefined &&
      runCost(state, opts.price) >= budget.maxCost,
    finalizeReserveMs: budget.finalizeReserveMs,
    structured: opts.structured,
    steerPending: state.pendingSteers.length > 0,
  }
  if (budget.maxTotalMs !== undefined && state.startedAt !== undefined) {
    result.timeLeftMs = state.startedAt + budget.maxTotalMs - opts.now
  }
  return result
}

function intentOpinion(obs: Observation): SourcedOpinion | undefined {
  const intent = obs.intent
  if (!intent) return undefined
  const source = `intent:${intent.tool}`
  switch (intent.kind) {
    case 'complete':
      return { source, opinion: { complete: true } }
    case 'await_input':
      return { source, opinion: { awaitInput: { code: intent.code } } }
    case 'stop':
      return { source, opinion: { stop: { code: intent.code, message: `意图 ${intent.tool}` } } }
  }
}

/** 干预自带的来源优先，否则用意见的来源。 */
const sourceOf = (i: Intervention, fallback: string): string =>
  (i as Partial<SourcedIntervention>).source ?? fallback

function mergeContinue(opinions: readonly SourcedOpinion[]): Verdict {
  const hints: SourcedIntervention[] = []
  const blocks: SourcedIntervention[] = []
  const seenHints = new Set<string>()
  const seenBlocks = new Set<string>()
  let remaining = MAX_HINT_CHARS
  for (const { source, opinion } of opinions) {
    if (!('continue' in opinion)) continue
    for (const i of opinion.continue.interventions ?? []) {
      if ('hint' in i) {
        if (seenHints.has(i.hint.text) || remaining <= 0) continue
        seenHints.add(i.hint.text)
        const text = i.hint.text.slice(0, remaining)
        remaining -= text.length
        hints.push({ hint: { text }, source: sourceOf(i, source) })
      } else {
        const key = `${i.block.tool}\u0000${i.block.inputHash}`
        if (seenBlocks.has(key)) continue
        seenBlocks.add(key)
        blocks.push({ block: i.block, source: sourceOf(i, source) })
      }
    }
  }
  return {
    continue: { interventions: [...hints, ...blocks] },
    sources: opinions.filter((o) => 'continue' in o.opinion).map((o) => o.source),
  }
}

function stopVerdict(code: string, message: string, sources: string[]): Verdict {
  return { stop: { code, message }, sources }
}

function endVerdict(code: string, message: string, guard: string, structured: boolean): Verdict {
  return structured ? stopVerdict(code, message, [guard]) : { finalize: { code }, sources: [guard] }
}

export function decide(
  obs: Observation,
  opinions: readonly SourcedOpinion[],
  budget: BudgetState,
): Verdict {
  // 合并前守卫。
  if (obs.finishReason === 'content-filter') {
    return stopVerdict('content_filter', '模型输出被内容过滤', ['guard:content_filter'])
  }

  // 来源顺序：违规 → 待审批 → 意图 → 候选 → 各守卫（调用方按任务、执行环境、能力、引擎、预算排好）。
  const sourced: SourcedOpinion[] = []
  const violated = obs.interventions.violated[0]
  if (violated)
    sourced.push({ source: 'guard:violation', opinion: { finalize: { code: violated.code } } })
  // 审批稍后答复：这一轮到此为止，等委托人答复（设计 §9.10）。
  if (obs.toolCalls.some((c) => c.errorCode === 'APPROVAL_PENDING')) {
    sourced.push({
      source: 'guard:approval',
      opinion: { awaitInput: { code: 'approval_pending' } },
    })
  }
  const intent = intentOpinion(obs)
  if (intent) sourced.push(intent)
  if (obs.isFinalCandidate && obs.intent?.kind !== 'complete') {
    sourced.push({ source: 'candidate', opinion: { complete: true } })
  }
  sourced.push(...opinions)

  let verdict: Verdict
  if (sourced.length === 0) {
    verdict = { continue: { interventions: [] }, sources: ['default'] }
  } else {
    const top = Math.max(...sourced.map((o) => RANK[kindOf(o.opinion)]))
    const winner = sourced.find((o) => RANK[kindOf(o.opinion)] === top)!
    verdict =
      kindOf(winner.opinion) === 'continue'
        ? mergeContinue(sourced)
        : ({ ...winner.opinion, sources: [winner.source] } as Verdict)
  }

  // 委托人引导优先（设计 §10.5）：引导到了还没生效，不按旧方向结束，下一步带着引导重来。
  // 引擎和守卫的停止不让；预算用完的检查在后面照常进行。
  const intentStop = 'stop' in verdict && verdict.sources.some((s) => s.startsWith('intent:'))
  if (budget.steerPending && !('continue' in verdict) && (!('stop' in verdict) || intentStop)) {
    verdict = { continue: { interventions: [] }, sources: ['principal:steer'] }
  }

  // 合并后守卫。
  if ('continue' in verdict && budget.stepsLeft <= 0) {
    verdict = endVerdict('max_steps', '步数已用完', 'guard:max_steps', budget.structured)
  }
  if ('continue' in verdict && (budget.tokensExhausted || budget.costExhausted)) {
    verdict = stopVerdict('budget', 'token 或费用已用完', ['guard:budget'])
  }
  if (
    'continue' in verdict &&
    budget.timeLeftMs !== undefined &&
    budget.timeLeftMs <= budget.finalizeReserveMs
  ) {
    verdict = endVerdict('timeout', '剩余时长不足', 'guard:timeout', budget.structured)
  }
  if ('finalize' in verdict && budget.structured) {
    const code = verdict.finalize.code
    verdict = stopVerdict(code, `finalize:${code} 在结构化交付下改为停止`, [
      ...verdict.sources,
      'guard:structured',
    ])
  }
  return verdict
}
