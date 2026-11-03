// 律所的规矩：挂在执行环境上，所有在这里工作的 agent 都要遵守。
// 须知（免责声明、利益冲突审查）、权限（客户授权发函）、审批人（律师复核）、守卫（不得承诺结果）、
// 强制验收（意见书必须带免责声明）。业务团队改规矩只动这里，不动 agent。

import {
  thresholdGuard,
  type Approver,
  type AskRequest,
  type Check,
  type Guard,
  type NoticeProvider,
  type PermissionRule,
  type Segment,
} from 'agent-engine'
import { FIRM_CLIENTS, OpinionSchema } from './domain.ts'

const system = (text: string): Segment => ({ role: 'system', parts: [{ type: 'text', text }] })

// ── 须知 ───────────────────────────────────────────────────────────

/** 固定须知：执业边界。 */
export const PRACTICE_SCOPE = system(
  '你代表律所提供初步法律咨询：只基于检索到的法规和案情分析，不承诺诉讼结果；需要代理、发函等动作时先取得客户授权。',
)

/** 动态须知：每次运行生成，带上值班律师和今天的日期；时间只从 ctx.clock 取，重放时一致。 */
export function dutyNotice(lawyerOnDuty: string): NoticeProvider {
  return {
    id: 'duty-notice',
    version: '1',
    config: { lawyerOnDuty },
    async provide(_run, ctx) {
      const today = new Date(ctx.clock.now()).toISOString().slice(0, 10)
      return [system(`今天是 ${today}，值班律师 ${lawyerOnDuty}，需要人工复核的动作由其审批。`)]
    },
  }
}

/** 利益冲突审查：对方当事人是本所客户时拦下这次咨询，运行以 stopped / notice_blocked 结束。 */
export const conflictCheck: NoticeProvider = {
  id: 'conflict-check',
  version: '1',
  config: { firmClients: [...FIRM_CLIENTS] },
  async provide(run) {
    const opposing = run.task.context?.opposingParty
    if (typeof opposing === 'string' && FIRM_CLIENTS.includes(opposing)) {
      return { block: `利益冲突：${opposing} 是本所客户，本所不能就此事提供咨询，请另行委托。` }
    }
    return []
  },
}

// ── 权限与审批 ─────────────────────────────────────────────────────

/** 发律师函必须有客户的书面授权（记在任务的业务上下文里）；没有就拒绝，模型会改为建议客户先授权。 */
export const clientConsentRule: PermissionRule = {
  id: 'client-consent',
  version: '1',
  async permit(call, run) {
    if (call.toolName !== 'send_demand_letter') return 'allow'
    return run.task.context?.clientConsent === true
      ? 'allow'
      : { deny: '客户尚未书面授权以律所名义发函，请先取得授权。' }
  },
}

export interface ReviewRecord {
  tool: string
  summary: string
  approved: boolean
  reviewer: string
}

/** 审批人：律师复核队列。演示里金额不超过上限就批准；真实系统里这里会挂到复核工作台，等律师点批准。 */
export function lawyerReview(opts: {
  reviewer: string
  maxAmount: number
  log: ReviewRecord[]
}): Approver {
  return {
    async approve(req: AskRequest & { callId: string; toolName: string }) {
      const amount = Number(/"amount":\s*(\d+)/.exec(req.detail?.input ?? '')?.[1] ?? 0)
      const approved = amount <= opts.maxAmount
      opts.log.push({ tool: req.toolName, summary: req.summary, approved, reviewer: opts.reviewer })
      return { approved }
    },
  }
}

// ── 守卫 ───────────────────────────────────────────────────────────

const PROMISE = /保证胜诉|一定能赢|稳赢|包赢/

/**
 * 不得承诺结果：回复里出现承诺就告知模型（纠偏消息里带上问题和建议）；再犯就收尾。
 * 用标准库的计数守卫搭出来：只写"数什么"，告知与终止的节奏由 thresholdGuard 负责。
 */
export const noOutcomePromise: Guard = thresholdGuard({
  id: 'no-outcome-promise',
  warn: 1,
  end: 2,
  count: () => (facts) => (PROMISE.test(facts.text) ? 1 : 0),
  code: () => 'outcome_promise',
  problem: () => '回复里承诺了诉讼结果，违反执业规范',
  suggest: '改为说明胜诉取决于哪些证据和条件，以及主要风险',
})

// ── 强制验收 ───────────────────────────────────────────────────────

/** 律所的强制验收：意见书必须带免责声明。叠加在交付物自己的验收之后。 */
export const disclaimerRequired: Check = {
  id: 'disclaimer-required',
  version: '1',
  mode: 'gate',
  start: () => ({
    async accept(candidate) {
      const parsed = OpinionSchema.safeParse(candidate.output)
      if (!parsed.success || parsed.data.disclaimer.includes('不构成正式法律意见'))
        return { pass: true }
      return {
        pass: false,
        issues: ['意见书缺少免责声明'],
        hint: 'disclaimer 写明"本意见基于您提供的信息，仅供参考，不构成正式法律意见"。',
      }
    },
  }),
}
