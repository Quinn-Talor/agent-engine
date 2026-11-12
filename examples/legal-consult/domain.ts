// 业务领域：法规节选、客户档案、本所客户名单、法律意见书的结构。
// 示例数据：条文为节选，案情虚构，仅用于演示，不构成法律意见。

import { z } from 'zod'
import type { DomainValidate } from '@talor/agent-engine'

// ── 法规库 ─────────────────────────────────────────────────────────

export interface Statute {
  law: string
  article: string
  text: string
  keywords: string[]
}

export const STATUTES: readonly Statute[] = [
  {
    law: '劳动合同法',
    article: '第三十条',
    text: '用人单位应当按照劳动合同约定和国家规定，向劳动者及时足额支付劳动报酬。',
    keywords: ['工资', '拖欠', '劳动报酬'],
  },
  {
    law: '劳动合同法',
    article: '第三十八条',
    text: '用人单位有下列情形之一的，劳动者可以解除劳动合同：……（二）未及时足额支付劳动报酬的；……',
    keywords: ['解除', '拖欠', '辞职'],
  },
  {
    law: '劳动合同法',
    article: '第四十六条',
    text: '有下列情形之一的，用人单位应当向劳动者支付经济补偿：（一）劳动者依照本法第三十八条规定解除劳动合同的；……',
    keywords: ['经济补偿', '补偿', '解除'],
  },
  {
    law: '劳动合同法',
    article: '第四十七条',
    text: '经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。六个月以上不满一年的，按一年计算；不满六个月的，向劳动者支付半个月工资的经济补偿。',
    keywords: ['经济补偿', '补偿', '计算', '年限'],
  },
  {
    law: '劳动争议调解仲裁法',
    article: '第二十七条',
    text: '劳动争议申请仲裁的时效期间为一年。……劳动关系存续期间因拖欠劳动报酬发生争议的，劳动者申请仲裁不受本条第一款规定的仲裁时效期间的限制；但是，劳动关系终止的，应当自劳动关系终止之日起一年内提出。',
    keywords: ['仲裁', '时效', '拖欠'],
  },
]

/** 引用写法：《劳动合同法》第三十八条。意见书的 citations 必须用这个写法，验收按它到资料里核对。 */
export const citationOf = (s: Statute): string => `《${s.law}》${s.article}`

// ── 客户档案 ───────────────────────────────────────────────────────

export interface Dossier {
  clientId: string
  name: string
  employer: string
  hiredAt: string
  monthlySalary: number
  unpaidMonths: number
  version: number
}

/** 档案库：版本号随每次修改增加；运行中档案变了，按旧档案得出的意见就不可信。 */
export class DossierStore {
  private readonly dossiers = new Map<string, Dossier>()
  /** 演示"同事在运行中改了档案"：读到第几次时自动改一次。 */
  private readonly editOnRead = new Map<string, number>()

  constructor(initial: Dossier[]) {
    for (const d of initial) this.dossiers.set(d.clientId, { ...d })
  }

  get(clientId: string): Dossier | undefined {
    const left = this.editOnRead.get(clientId)
    if (left !== undefined) {
      if (left <= 1) {
        this.editOnRead.delete(clientId)
        this.update(clientId, {
          unpaidMonths: (this.dossiers.get(clientId)?.unpaidMonths ?? 0) + 1,
        })
      } else this.editOnRead.set(clientId, left - 1)
    }
    const d = this.dossiers.get(clientId)
    return d && { ...d }
  }

  version(clientId: string): number | undefined {
    return this.dossiers.get(clientId)?.version
  }

  update(clientId: string, patch: Partial<Omit<Dossier, 'clientId' | 'version'>>): void {
    const d = this.dossiers.get(clientId)
    if (d) this.dossiers.set(clientId, { ...d, ...patch, version: d.version + 1 })
  }

  simulateEditOnRead(clientId: string, nth = 1): void {
    this.editOnRead.set(clientId, nth)
  }
}

export const SAMPLE_DOSSIERS: Dossier[] = [
  {
    clientId: 'C-1024',
    name: '王女士',
    employer: '星河科技有限公司',
    hiredAt: '2021-03-01',
    monthlySalary: 12000,
    unpaidMonths: 3,
    version: 1,
  },
]

/** 本所的企业客户：对方当事人在名单里，就有利益冲突，不能接这个咨询。 */
export const FIRM_CLIENTS: readonly string[] = ['蓝湾物流有限公司']

// ── 法律意见书 ─────────────────────────────────────────────────────

export const OpinionSchema = z.object({
  summary: z.string().min(1),
  facts: z.array(z.string()).min(1),
  analysis: z
    .array(z.object({ issue: z.string(), conclusion: z.string(), citations: z.array(z.string()) }))
    .min(1),
  compensation: z.object({ months: z.number(), amount: z.number() }).optional(),
  precedents: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).min(1),
  disclaimer: z.string(),
})

export type Opinion = z.infer<typeof OpinionSchema>

export const CITATION_HINT = '每条分析都要写明依据的法条'

/** 领域校验：每条分析都要有依据。不合格时带提示退回，计一次自修。 */
export const everyIssueCited: DomainValidate<Opinion> = async (opinion) => {
  const bare = opinion.analysis.filter((a) => a.citations.length === 0).map((a) => a.issue)
  if (bare.length === 0) return { ok: true }
  return {
    ok: false,
    issues: bare.map((issue) => `「${issue}」没有写依据`),
    hint: `${CITATION_HINT}，写法如《劳动合同法》第三十八条。`,
  }
}
