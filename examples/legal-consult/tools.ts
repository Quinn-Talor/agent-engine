// 业务工具：法规检索、经济补偿计算、发律师函。工具只管做事；能不能做、要不要审批由执行环境的权限决定。

import { z } from 'zod'
import { toolError, type ToolDef } from 'agent-engine'
import { STATUTES, citationOf } from './domain.ts'

/** 法规检索：只读，没有副作用。 */
export const searchStatutes: ToolDef = {
  name: 'search_statutes',
  description: '按关键词检索劳动法规，返回条文节选和引用写法。',
  inputSchema: z.object({ query: z.string().min(1) }),
  execution: { effect: 'none' },
  async execute(input) {
    const words = (input as { query: string }).query.split(/\s+/).filter(Boolean)
    const hits = STATUTES.filter((s) => words.some((w) => s.keywords.some((k) => k.includes(w))))
    if (hits.length === 0) return '没有检索到相关条文，换个关键词再试。'
    return hits.map((s) => `${citationOf(s)}：${s.text}`).join('\n')
  },
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const monthsBetween = (from: string, to: string) => {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number]
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number]
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0)
}

/**
 * 经济补偿（《劳动合同法》第四十七条）：每满一年一个月工资；六个月以上不满一年按一年；不满六个月半个月。
 * 演示没有处理高收入封顶等情形。
 */
export const calcCompensation: ToolDef = {
  name: 'calc_compensation',
  description: '按工作年限计算解除劳动合同的经济补偿。日期格式 YYYY-MM-DD。',
  inputSchema: z.object({
    monthlySalary: z.number(),
    hiredAt: z.string(),
    leftAt: z.string(),
  }),
  execution: { effect: 'none' },
  // 工具自己的输入校验（流水线 d 环节）：不合格不执行，模型收到 INVALID_INPUT 后修正参数。
  validate(input) {
    const { monthlySalary, hiredAt, leftAt } = input as {
      monthlySalary: number
      hiredAt: string
      leftAt: string
    }
    if (!(monthlySalary > 0)) return { error: toolError('INVALID_INPUT', '月工资必须大于 0') }
    if (!DATE.test(hiredAt) || !DATE.test(leftAt) || hiredAt >= leftAt) {
      return { error: toolError('INVALID_INPUT', '入职日期必须早于离职日期，格式 YYYY-MM-DD') }
    }
    return { ok: true }
  },
  async execute(input) {
    const { monthlySalary, hiredAt, leftAt } = input as {
      monthlySalary: number
      hiredAt: string
      leftAt: string
    }
    const total = monthsBetween(hiredAt, leftAt)
    const years = Math.floor(total / 12)
    const rest = total % 12
    const months = years + (rest >= 6 ? 1 : rest > 0 ? 0.5 : 0)
    return `工作 ${years} 年 ${rest} 个月，经济补偿 ${months} 个月工资，合计 ${months * monthlySalary} 元。`
  },
}

export interface Letter {
  recipient: string
  amount: number
  deadlineDays: number
  /** 同一次调用重试时不变，用来去重。 */
  idempotencyKey: string
}

/** 发律师函：有副作用、高风险。引擎不会自动重做，权限规则和审批决定能不能发。 */
export function sendDemandLetter(outbox: Letter[]): ToolDef {
  return {
    name: 'send_demand_letter',
    description: '以律所名义向对方发出催告律师函。',
    inputSchema: z.object({
      recipient: z.string().optional(),
      amount: z.number(),
      deadlineDays: z.number().default(15),
    }),
    execution: { effect: 'side_effect' },
    safety: { risk: 'high' },
    async execute(input, ctx) {
      const { recipient, amount, deadlineDays } = input as {
        recipient: string
        amount: number
        deadlineDays: number
      }
      const sent = outbox.find((l) => l.idempotencyKey === ctx.idempotencyKey)
      if (!sent)
        outbox.push({ recipient, amount, deadlineDays, idempotencyKey: ctx.idempotencyKey })
      return `律师函已发给 ${recipient}，催告 ${deadlineDays} 日内支付 ${amount} 元。`
    },
  }
}
