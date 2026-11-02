// 交付环节（设计 §3.11、§8.4）：只在判定为完成或收尾时进入。
// 正常路径：输出校验 → 拦截验收（先交付物、后执行环境）→ 定稿 → 标注验收。
// 兜底路径：三级退化生成阶段性交付 → sanitize → 定稿 → 标注验收。每次运行最多走一次兜底（I1）。

import type { Deliverable } from '../contracts/agent.js'
import type { Clock } from '../contracts/common.js'
import type {
  Candidate,
  Check,
  CheckMode,
  ComponentCtx,
  Corpus,
  Fallback,
  RunInfo,
} from '../contracts/component.js'
import type { RunEventBody } from '../contracts/events.js'
import type { ModelInput, ModelPrice } from '../contracts/model.js'
import type { Notice } from '../contracts/run.js'
import { checkResultIssue } from '../core/component-results.js'
import { budgetState } from '../core/decide.js'
import { estimateMessages, estimateTools } from '../core/estimate.js'
import { copyData } from '../core/freeze.js'
import type { RunState } from '../core/state.js'
import { callComponent, failureDetail } from './call-component.js'

const DEFAULT_MAX_REPAIRS = 3
const DEFAULT_MAX_ATTEMPTS = 1
const MIN_LEVEL1_MS = 1000
const DEADLINE_ISSUE = '截止时间到，验收没有完成'

export interface DeliverDeps {
  run: RunInfo
  clock: Clock
  /** 生效的交付物：任务的覆盖 Agent 的，再缺省为引擎默认值；兜底说明已补齐。 */
  deliverable: Deliverable & { fallback: Fallback }
  /** 执行环境的强制验收，叠加在交付物的验收之后。 */
  environmentChecks: readonly Check[]
  ctxFor(source: string): ComponentCtx
  corpus(): Promise<Corpus>
  notify(notice: Notice): void
  /** 禁用工具调用一次模型；失败返回 undefined（由执行器记录 external_call）。 */
  generate(input: ModelInput, timeoutMs: number): Promise<string | undefined>
  currentView(): ModelInput | Promise<ModelInput>
  minimalView(): ModelInput
  /** 已执行与可能已执行的副作用，每项一行。 */
  sideEffects(): string[]
  finalizeReserveMs: number
  /** 离截止还剩多少毫秒；没有时长预算时不提供。兜底生成不超过它。 */
  timeLeftMs?(): number
  /** 运行模型的价格；有价格时退回前也检查费用。 */
  price?: ModelPrice
  componentTimeoutMs?: number
  /** 运行的取消信号：取消后跳过剩余的验收与兜底级别，不再定稿（设计 §3.14）。 */
  signal?: AbortSignal
  /** 是否算取消；不提供时按信号判断。到截止时间不算取消，兜底仍交出固定文本。 */
  cancelled?(): boolean
}

export interface Delivery {
  deliver(state: RunState): Promise<RunEventBody[]>
}

type CheckRecord = { source: string; mode: CheckMode; pass: boolean; issues?: string[] }
type Accept = ReturnType<Check['start']>['accept']

export function fallbackPrompt(
  fallback: Fallback,
  code: string,
  reachable: boolean,
  sideEffects: readonly string[],
  goal?: string,
): string {
  const entry = fallback.instructions[code] ?? fallback.instructions['*']
  const instruction = entry ? (reachable ? entry.reachable : entry.unreachable) : fallback.fixedText
  const list = sideEffects.length > 0 ? sideEffects.map((s) => `- ${s}`).join('\n') : '无'
  const body = `${instruction}\n\n已执行的副作用：\n${list}`
  // 视图里有会话历史；不点明本次任务时，模型会把前几轮也一起汇报（F24）。
  const task = goal?.trim()
  return task
    ? `本次任务：${task}\n只针对本次任务作答：之前对话里的内容只是背景，不要再汇报。\n\n${body}`
    : body
}

export function createDelivery(deps: DeliverDeps): Delivery {
  const { deliverable, clock } = deps
  const output = deliverable.output
  // 同一 id 的验收只跑一次，以执行环境的强制验收为准（例如默认带的完成审查与环境要求的重复）。
  const required = new Set(deps.environmentChecks.map((c) => c.id))
  const checks = [
    ...(deliverable.checks ?? []).filter((c) => !required.has(c.id)),
    ...deps.environmentChecks,
  ]
  const instances = new Map<string, Accept | null>()
  const gateReturns = new Map<string, number>()
  let normalAttempts = 0
  let fallbackAttempts = 0
  let outputFailures = 0
  let repairs = 0
  /** 正常路径因预算转兜底时的 code；delivery_checked 的 fallback 本身只表达 empty_output。 */

  const aborted = () => (deps.cancelled ? deps.cancelled() : deps.signal?.aborted === true)
  const call = <T>(fn: () => Promise<T>, validate?: (value: T) => string | undefined) =>
    callComponent(fn, {
      clock,
      timeoutMs: deps.componentTimeoutMs,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(validate ? { validate } : {}),
    })

  /**
   * 退回前按判定的合并后检查看预算（core/decide.ts）：步数或时间不够时文本交付转兜底、结构化交付停止
   * （兜底只能产出文本）；token 或费用用完时停止。还有下一步可用时返回 undefined。
   */
  const exhausted = (
    state: RunState,
  ): { outcome: 'fallback' | 'stopped'; code: string } | undefined => {
    const structured = output.kind === 'structured'
    const budget = budgetState(state, {
      now: clock.now(),
      structured,
      ...(deps.price ? { price: deps.price } : {}),
    })
    const end = (code: string) => ({ outcome: structured ? 'stopped' : 'fallback', code }) as const
    if (budget.stepsLeft <= 0) return end('max_steps')
    if (budget.tokensExhausted || budget.costExhausted)
      return { outcome: 'stopped', code: 'budget' }
    if (budget.timeLeftMs !== undefined && budget.timeLeftMs <= budget.finalizeReserveMs) {
      return end('timeout')
    }
    return undefined
  }

  /** 验收实例在首次使用时启动；启动失败的验收按通过处理。 */
  const acceptOf = (check: Check, source: string): Accept | null => {
    if (!instances.has(source)) {
      try {
        instances.set(source, check.start(deps.run, deps.ctxFor(source)).accept)
      } catch (error) {
        deps.ctxFor(source).log('warn', `验收 ${check.id} 启动出错`, { error: String(error) })
        instances.set(source, null)
      }
    }
    return instances.get(source)!
  }

  const runCheck = async (
    check: Check,
    candidate: Candidate,
    corpus: Corpus,
  ): Promise<{ record: CheckRecord; hint?: string; interrupted?: true }> => {
    const source = `check:${check.id}`
    const accept = acceptOf(check, source)
    if (!accept) return { record: { source, mode: check.mode, pass: true } }
    const outcome = await call(() => accept(candidate, corpus), checkResultIssue)
    // 因取消而出错的验收不算通过。
    if (!outcome.ok && aborted()) return { record: { source, mode: check.mode, pass: false } }
    // 截止时间到被中断的验收没有给出结论：不算通过，记为未解决；已经没有时间退回修改。
    if (!outcome.ok && !outcome.invalid && deps.signal?.aborted) {
      deps.ctxFor(source).log('warn', `验收 ${check.id} 被截止时间中断`)
      return {
        record: { source, mode: check.mode, pass: false, issues: [DEADLINE_ISSUE] },
        interrupted: true,
      }
    }
    // 出错与返回值不合格：按设计 §4.4 视为通过，记入诊断日志。
    if (!outcome.ok) {
      const why = outcome.invalid ? `返回值不合格：${outcome.invalid.issue}` : '出错'
      deps.ctxFor(source).log('warn', `验收 ${check.id} ${why}`, failureDetail(outcome))
      return { record: { source, mode: check.mode, pass: true } }
    }
    const result = outcome.value
    if (result.pass) return { record: { source, mode: check.mode, pass: true } }
    return {
      record: { source, mode: check.mode, pass: false, issues: result.issues },
      hint: result.hint,
    }
  }

  const annotate = async (candidate: Candidate, corpus: Corpus): Promise<CheckRecord[]> => {
    const records: CheckRecord[] = []
    for (const check of checks.filter((c) => c.mode === 'annotate')) {
      const { record } = await runCheck(check, candidate, corpus)
      if (aborted()) break
      records.push(record)
    }
    return records
  }

  /** 提交的参数不符合输出契约的 schema 时的问题；交付环节按输出校验不合格处理。 */
  let schemaIssues: string[] | undefined

  const candidateOf = (state: RunState): Candidate => {
    schemaIssues = undefined
    if (!state.observation) throw new Error('unreachable: deliver without observation')
    const c = state.candidate
    const candidate: Candidate = {
      step: c?.step ?? state.step,
      text: c?.text ?? '',
      observation: state.observation,
    }
    const intent = c?.intent
    if (
      output.kind === 'structured' &&
      intent?.kind === 'complete' &&
      output.tools?.some((t) => t.name === intent.tool)
    ) {
      // 复制一份：intent.input 来自冻结的日志事件，schema 解析结果也可能引用其中的子对象。
      const schema = output.schema
      if (!schema) candidate.output = copyData(intent.input)
      else {
        const parsed = schema.safeParse(intent.input)
        if (parsed.success) candidate.output = copyData(parsed.data)
        else {
          schemaIssues = (parsed.error?.issues ?? []).map(
            (i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`,
          )
          if (schemaIssues.length === 0) schemaIssues = ['参数不符合 schema']
        }
      }
    }
    return candidate
  }

  const normal = async (state: RunState): Promise<RunEventBody[]> => {
    normalAttempts += 1
    const candidate = candidateOf(state)
    const checked = (
      fields: Pick<
        Extract<RunEventBody, { t: 'delivery_checked' }>,
        'output' | 'checks' | 'outcome' | 'code'
      > & {
        hint?: string
      },
    ): RunEventBody[] => [
      {
        t: 'delivery_checked',
        step: candidate.step,
        path: 'normal',
        attempt: normalAttempts,
        ...fields,
        ...(fields.hint === undefined ? {} : { hint: fields.hint }),
      },
    ]
    // 退回前先看预算：文本交付没有下一步可用时转兜底路径，不再多走一步。
    const giveBack = (
      fields: Pick<Extract<RunEventBody, { t: 'delivery_checked' }>, 'output' | 'checks'> & {
        hint?: string
      },
    ): RunEventBody[] => {
      const end = exhausted(state)
      if (end === undefined) return checked({ ...fields, outcome: 'returned' })
      return checked({ output: fields.output, checks: fields.checks, ...end })
    }

    // 1. 输出校验：提交的参数先按 schema 解析，不合格直接按输出不合格处理。
    const validated = schemaIssues
      ? {
          ok: true as const,
          value: {
            ok: false as const,
            issues: schemaIssues,
            hint: `submit 的参数不符合 schema：\n${schemaIssues.map((i) => `- ${i}`).join('\n')}\n逐项修正后重新调用 submit。`,
          },
        }
      : await call(() => output.validate(candidate, deps.ctxFor('output')))
    if (aborted()) return []
    const verdict = validated.ok
      ? validated.value
      : { ok: false as const, issues: ['输出校验出错'], hint: '请重新给出交付内容' }
    if (!verdict.ok) {
      const failed = { ok: false, issues: verdict.issues }
      if (output.kind === 'text') {
        outputFailures += 1
        return outputFailures === 1
          ? giveBack({ output: failed, checks: [], hint: verdict.hint })
          : checked({ output: failed, checks: [], outcome: 'fallback' })
      }
      repairs += 1
      return repairs > (output.maxRepairs ?? DEFAULT_MAX_REPAIRS)
        ? checked({ output: failed, checks: [], outcome: 'failed' })
        : giveBack({ output: failed, checks: [], hint: verdict.hint })
    }

    // 2. 拦截类验收（shadow 同阶段只记录）
    const corpus = await deps.corpus()
    const records: CheckRecord[] = []
    for (const check of checks.filter((c) => c.mode === 'gate' || c.mode === 'shadow')) {
      const { record, hint, interrupted } = await runCheck(check, candidate, corpus)
      if (aborted()) return []
      records.push(record)
      if (check.mode !== 'gate' || record.pass || interrupted) continue
      const used = gateReturns.get(record.source) ?? 0
      if (used < (check.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        gateReturns.set(record.source, used + 1)
        return giveBack({ output: { ok: true }, checks: records, hint })
      }
    }

    // 3. 定稿（取消后不再交付）
    if (aborted()) return []
    deps.notify({
      t: 'delivered',
      text: candidate.text ?? '',
      ...(candidate.output === undefined ? {} : { output: candidate.output }),
    })
    // 4. 标注类验收
    records.push(...(await annotate(candidate, corpus)))
    // 标注期间取消：不再定稿（设计 §3.14 取消后不再交付）。
    if (aborted()) return []
    return checked({ output: { ok: true }, checks: records, outcome: 'delivered' })
  }

  const fallbackPath = async (state: RunState): Promise<RunEventBody[]> => {
    fallbackAttempts += 1
    const code = state.fallbackCode ?? '*'
    const start = clock.now()
    const prompt = fallbackPrompt(
      deliverable.fallback,
      code,
      deps.run.environment.principalReachable,
      deps.sideEffects(),
      deps.run.task.goal,
    )
    const withPrompt = (view: ModelInput): ModelInput => ({
      ...view,
      messages: [...view.messages, { role: 'user', content: prompt }],
      toolChoice: 'none',
    })
    const usable = (text: string | undefined): text is string => !!text && text.trim().length > 0
    // I7：估算达到上下文上限的级别不调用模型，直接退到下一级（与组装的超限检查同一口径）。
    const fits = (input: ModelInput) =>
      Math.ceil(
        (estimateMessages(input.messages) + estimateTools(input.tools)) * state.calibration,
      ) < state.contextLimit
    const sanitize = (text: string, corpus: Corpus): string | undefined => {
      if (!output.sanitize) return text
      try {
        return output.sanitize(text, corpus)
      } catch (error) {
        deps.ctxFor('output').log('warn', 'sanitize 出错', { error: String(error) })
        return undefined
      }
    }

    let degradation: 0 | 1 | 2 = 0
    // 兜底用收尾预留，但不超过离截止实际还剩的时间。
    const allowed = Math.min(deps.finalizeReserveMs, deps.timeLeftMs?.() ?? Infinity)
    const level0 = withPrompt(await deps.currentView())
    let text = allowed > 0 && fits(level0) ? await deps.generate(level0, allowed) : undefined
    if (aborted()) return []
    if (!usable(text)) {
      degradation = 1
      const remaining = allowed - (clock.now() - start)
      const level1 = withPrompt(deps.minimalView())
      text =
        remaining >= MIN_LEVEL1_MS && fits(level1)
          ? await deps.generate(level1, remaining)
          : undefined
      if (aborted()) return []
    }
    if (!usable(text)) {
      degradation = 2
      text = deliverable.fallback.fixedText
    }
    const corpus = await deps.corpus()
    // sanitize 出错按输出契约出错处理（§4.4 视为不合格）：退到固定文本。
    let clean = sanitize(text, corpus)
    if (clean === undefined) {
      degradation = 2
      const fixedText = deliverable.fallback.fixedText
      clean = sanitize(fixedText, corpus) ?? fixedText
    }
    text = clean
    if (aborted()) return []

    deps.notify({ t: 'delivered', text })
    const candidate: Candidate = {
      step: state.step,
      text,
      observation: state.observation ?? emptyObservation(state.step),
    }
    const records = await annotate(candidate, corpus)
    if (aborted()) return []
    return [
      { t: 'fallback_generated', code, text, degradation },
      {
        t: 'delivery_checked',
        step: state.step,
        path: 'fallback',
        attempt: fallbackAttempts,
        output: { ok: true },
        checks: records,
        outcome: 'delivered',
      },
    ]
  }

  return {
    deliver: (state) => (state.deliveryPath === 'fallback' ? fallbackPath(state) : normal(state)),
  }
}

function emptyObservation(step: number): Candidate['observation'] {
  return {
    step,
    text: '',
    toolCalls: [],
    allToolsFailed: null,
    isFinalCandidate: false,
    newInformation: false,
    finishReason: 'other',
    interventions: { applied: [], violated: [] },
    pressure: { context: 0, steps: 0, time: 0, tokens: 0, cost: 0 },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}
