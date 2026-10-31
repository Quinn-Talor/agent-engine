// ④ 观察 + ⑤ 反思 + ⑥ 判定（设计 §3.8–§3.10、docs/guard-mechanism.md §3）：事实 → 守卫 → 裁决，
// 写一条 evaluated 和 step_ended。守卫互相独立、并行执行，意见按来源顺序收集；出错或超时视为没有意见。
// 引擎规则：先告知后终止；委托人引导生效时所有守卫重新开始；告知统一渲染成一条纠偏消息。

import type { Clock } from '../contracts/common.js'
import type {
  CallBlock,
  ComponentCtx,
  Guard,
  GuardGroups,
  GuardOpinion,
  Intervention,
  Opinion,
  RunInfo,
  StepFacts,
} from '../contracts/component.js'
import type { BlobRef, RunEventBody } from '../contracts/events.js'
import type { ModelPrice } from '../contracts/model.js'
import { budgetGuard } from '../core/budget-guard.js'
import { budgetState, decide, type SourcedOpinion } from '../core/decide.js'
import { stepFacts } from '../core/facts.js'
import type { RunState, SourcedIntervention } from '../core/state.js'
import { renderFinding, renderSteering } from '../core/steering.js'
import { callComponent } from './call-component.js'

export interface EvaluateDeps {
  run: RunInfo
  clock: Clock
  guards: GuardGroups
  ctxFor(source: string): ComponentCtx
  price?: ModelPrice
  structured: boolean
  /** 解析本步工具输出的 blob，得到顾问用的输出开头。 */
  getBlob?: (ref: BlobRef) => Promise<string>
  componentTimeoutMs?: number
}

export interface Evaluator {
  evaluate(state: RunState): Promise<RunEventBody[]>
}

type Check = (facts: StepFacts) => GuardOpinion | undefined | Promise<GuardOpinion | undefined>
type OpinionRecord = Extract<RunEventBody, { t: 'evaluated' }>['opinions'][number]

interface Participant {
  source: string
  guard: Guard
}

const PRESSURE = budgetGuard()

/**
 * 告知换算成继续：一条发现提示 + 封路。带封路的告知只列问题：每条封路的原因和建议在纠偏消息的
 * 封路清单里列出，这里再写一遍就重复了。
 */
function warnOpinion(
  warn: { problem: string; suggest?: string; block?: CallBlock[] },
  detail?: string,
): Opinion {
  const text =
    warn.block && warn.block.length > 0
      ? renderFinding({ problem: warn.problem })
      : renderFinding(warn, detail)
  const interventions: Intervention[] = [{ hint: { text } }]
  for (const block of warn.block ?? []) interventions.push({ block })
  return { continue: { interventions } }
}

/** 出口：本次运行可用的意图工具（等待输入优先 ask_user）。 */
function exits(state: RunState): { askTool?: string; stopTool?: string } {
  const tools = Object.values(state.tools)
  const ask = tools.filter((t) => t.intent?.kind === 'await_input').map((t) => t.name)
  const askTool = ask.includes('ask_user') ? 'ask_user' : ask[0]
  const stopTool = tools.find((t) => t.intent?.kind === 'stop')?.name
  return { ...(askTool ? { askTool } : {}), ...(stopTool ? { stopTool } : {}) }
}

export function createEvaluator(deps: EvaluateDeps): Evaluator {
  const { guards } = deps
  const participants: Participant[] = [
    ...(guards.task ?? []).map((guard) => ({ source: `task:${guard.id}`, guard })),
    ...(guards.environment ?? []).map((guard) => ({ source: `environment:${guard.id}`, guard })),
    ...(guards.capability ?? []).map((guard) => ({ source: `capability:${guard.id}`, guard })),
    ...(guards.engine ?? []).map((guard) => ({ source: `engine:${guard.id}`, guard })),
    { source: 'guard:pressure', guard: PRESSURE },
  ]
  /** 运行内实例，首次使用时启动；启动失败的记为 null，此后每步都按出错处理。 */
  let instances = new Map<number, Check | null>()
  /** 已经告知过的来源（运行开始或最近一次引导之后）。 */
  let warned = new Set<string>()

  const checkOf = (i: number): Check | null => {
    if (!instances.has(i)) {
      const p = participants[i]!
      try {
        const instance = p.guard.start(deps.run, deps.ctxFor(p.source))
        instances.set(i, (facts) => instance.check(facts))
      } catch {
        instances.set(i, null)
      }
    }
    return instances.get(i)!
  }

  async function consult(i: number, facts: StepFacts): Promise<OpinionRecord> {
    const { source, guard } = participants[i]!
    const mode = guard.mode ?? 'active'
    const outcome = await callComponent(
      async () => {
        const check = checkOf(i)
        if (!check) throw new Error(`${source} 启动失败`)
        return check(facts)
      },
      { clock: deps.clock, timeoutMs: deps.componentTimeoutMs },
    )
    const base = { source, mode, durationMs: outcome.durationMs }
    if (!outcome.ok) {
      deps.ctxFor(source).log('warn', `${source} 出错`, {
        error: String(outcome.error),
        timedOut: outcome.timedOut,
      })
      return guard.onError === 'stop'
        ? {
            ...base,
            opinion: { stop: { code: `guard_error:${guard.id}`, message: `${source} 出错` } },
            error: true,
          }
        : { ...base, error: true }
    }
    const value = outcome.value
    if (!value) return base
    // 委托人联系不上：没有人会回答，等待输入改为收尾，同样先告知。
    const g: GuardOpinion =
      'awaitInput' in value && !deps.run.environment.principalReachable
        ? {
            end: { as: 'finalize', code: value.awaitInput.code },
            ...(value.detail !== undefined ? { detail: value.detail } : {}),
          }
        : value
    const detail = g.detail !== undefined ? { detail: g.detail } : {}
    if ('warn' in g) return { ...base, opinion: warnOpinion(g.warn, g.detail), ...detail }
    if ('awaitInput' in g) return { ...base, opinion: { awaitInput: g.awaitInput }, ...detail }
    const { as, code } = g.end
    if (mode === 'active' && !warned.has(source)) {
      // 规则 1：没有告知过就要求终止，本步改为告知，下一步再终止。
      const verb = as === 'stop' ? '停止' : '收尾'
      const deferred = warnOpinion({
        problem: `守卫判定需要${verb}（${code}）；问题如果持续，下一步将${verb}`,
      })
      return { ...base, opinion: deferred, ...detail, deferred: true }
    }
    const opinion: Opinion =
      as === 'stop'
        ? { stop: { code, message: g.detail ?? `${source} 要求停止` } }
        : { finalize: { code } }
    return { ...base, opinion, ...detail }
  }

  return {
    async evaluate(state) {
      // 时间压力与剩余时间按最近一条日志事件计算，回放时得到相同的事实和纠偏消息；
      // 预算用完的检查按判定时刻（守卫跑完之后），记在事件上供回放使用。
      const at = state.lastAt
      const previews = new Map<string, string>()
      if (deps.getBlob) {
        for (const r of Object.values(state.results)) {
          const shown = await deps.getBlob(r.shown)
          previews.set(
            r.callId,
            shown.replace(/^<tool_output>\n/, '').replace(/\n<\/tool_output>$/, ''),
          )
        }
      }
      const facts = stepFacts(state, { now: at, price: deps.price, previews })

      // 规则 2：引导生效的步，所有守卫重新开始。
      if (facts.interventions.applied.some((a) => a.kind === 'steer')) {
        instances = new Map()
        warned = new Set()
      }

      const opinions = await Promise.all(participants.map((_, i) => consult(i, facts)))
      const active: SourcedOpinion[] = opinions
        .filter((r) => r.mode === 'active' && r.opinion)
        .map((r) => ({ source: r.source, opinion: r.opinion! }))
      const now = deps.clock.now()
      let verdict = decide(
        facts,
        active,
        budgetState(state, { now, price: deps.price, structured: deps.structured }),
      )

      if ('continue' in verdict) {
        const interventions = (verdict.continue.interventions ?? []) as SourcedIntervention[]
        // "告知过"以真正送到模型为准：被字数上限挤掉、或本步没有继续的告知都不算。
        for (const i of interventions) if ('hint' in i) warned.add(i.source)
        const findings = interventions.flatMap((i) => ('hint' in i ? [i.hint.text] : []))
        if (findings.length > 0) {
          const blocks = interventions.filter((i) => 'block' in i)
          const { budget } = state
          const timeLeftMs =
            budget.maxTotalMs !== undefined && state.startedAt !== undefined
              ? state.startedAt + budget.maxTotalMs - at
              : undefined
          const text = renderSteering({
            step: state.step,
            ...(deps.run.task.goal ? { goal: deps.run.task.goal } : {}),
            findings,
            blocks: blocks.flatMap((i) => ('block' in i ? [i.block] : [])),
            ...(facts.stepsLeft !== undefined ? { stepsLeft: facts.stepsLeft } : {}),
            ...(timeLeftMs !== undefined ? { timeLeftMs } : {}),
            ...exits(state),
          })
          const steering: SourcedIntervention = { hint: { text }, source: 'steering' }
          verdict = { ...verdict, continue: { interventions: [steering, ...blocks] } }
        }
      }

      return [
        { t: 'evaluated', step: state.step, observation: facts, opinions, verdict, decidedAt: now },
        { t: 'step_ended', step: state.step },
      ]
    },
  }
}
