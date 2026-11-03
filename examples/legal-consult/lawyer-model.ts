// 脚本化的"律师模型"：代替真实的大模型，让演示不联网、每次结果一样。
// 它像真实模型一样只看请求里的对话（任务、工具结果、纠偏和退回的提示）来决定下一步，
// 所以引擎的每个机制（审批、守卫、验收退回、兜底……）都会真实地生效。换成真实模型见 README。

import type {
  ContentPart,
  ModelInput,
  ModelMessage,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from 'agent-engine'
import type { FakeReply } from 'agent-engine/testing'
import { CITATION_HINT, type Opinion } from './domain.ts'

type Part = ContentPart | ReasoningPart | ToolCallPart | ToolResultPart

/** 请求里的对话，按真实模型能看到的内容提问。 */
class Conversation {
  readonly input: ModelInput

  constructor(input: ModelInput) {
    this.input = input
  }

  private parts(): Array<{ role: string; part: Part }> {
    return this.input.messages.flatMap((m: ModelMessage) =>
      typeof m.content === 'string'
        ? [{ role: m.role, part: { type: 'text' as const, text: m.content } }]
        : (m.content as Part[]).map((part) => ({ role: m.role, part })),
    )
  }

  /** 这一步能用这个工具吗（工具呈现决定）。 */
  can(tool: string): boolean {
    return this.input.tools.some((t) => t.name === tool)
  }

  calls(tool: string): unknown[] {
    return this.parts().flatMap(({ part }) =>
      part.type === 'tool-call' && part.toolName === tool ? [part.input] : [],
    )
  }

  called(tool: string): boolean {
    return this.calls(tool).length > 0
  }

  results(tool: string): Array<{ output: string; isError: boolean }> {
    return this.parts().flatMap(({ part }) =>
      part.type === 'tool-result' && part.toolName === tool
        ? [{ output: part.output, isError: part.isError === true }]
        : [],
    )
  }

  /** 最近一次成功的结果。 */
  ok(tool: string): string | undefined {
    return this.results(tool)
      .filter((r) => !r.isError)
      .at(-1)?.output
  }

  /** 委托人、引擎或工具说过这句话（任务输入、纠偏消息、退回提示、工具结果）。 */
  heard(text: string): boolean {
    return this.parts().some(
      ({ role, part }) =>
        role !== 'assistant' &&
        ((part.type === 'text' && part.text.includes(text)) ||
          (part.type === 'tool-result' && part.output.includes(text))),
    )
  }

  /** 最后一次出现的匹配（从工具结果和委托人的话里找）。 */
  find(re: RegExp): RegExpExecArray | undefined {
    let last: RegExpExecArray | undefined
    for (const { role, part } of this.parts()) {
      if (role === 'assistant') continue
      const text = part.type === 'text' ? part.text : part.type === 'tool-result' ? part.output : ''
      last = re.exec(text) ?? last
    }
    return last
  }
}

type Call = [name: string, input: unknown]
const reply = (text: string, ...calls: Call[]): FakeReply => ({
  text,
  toolCalls: calls.map(([name, input]) => ({ name, input })),
})

const STEPS = ['查明事实', '检索法规', '检索类案', '计算补偿', '出具意见书']
const plan = (done: number): Call => [
  'update_plan',
  {
    items: STEPS.map((text, i) => ({
      id: String(i + 1),
      text,
      status: i < done ? 'done' : i === done ? 'in_progress' : 'pending',
    })),
  },
]

/** 委托人计划的离职日期（演示固定，计算结果可复现）。 */
const LEAVE_DATE = '2025-06-30'
const FACTS = /入职时间\s*(\d{4}-\d{2}-\d{2})，月薪\s*(\d+)\s*元，已欠\s*(\d+)\s*个月/
const EMPLOYER = /雇主(?:是)?\s*([^，。\s]+公司)/

interface Facts {
  hiredAt: string
  salary: number
  unpaid: number
  employer: string
}

function factsOf(c: Conversation): Facts | undefined {
  const m = c.find(FACTS)
  if (!m) return undefined
  return {
    hiredAt: m[1]!,
    salary: Number(m[2]),
    unpaid: Number(m[3]),
    employer: c.find(EMPLOYER)?.[1] ?? '用人单位',
  }
}

const compensationOf = (c: Conversation) => {
  const m = /经济补偿 ([\d.]+) 个月工资，合计 (\d+) 元/.exec(c.ok('calc_compensation') ?? '')
  return m ? { months: Number(m[1]), amount: Number(m[2]) } : undefined
}

function opinionOf(c: Conversation, facts: Facts): Opinion {
  const statutes = c.ok('search_statutes') ?? ''
  const cite = (...refs: string[]) => refs.filter((r) => statutes.includes(r))
  // 第一稿漏写了一条依据；被退回（提示里有 CITATION_HINT）后补上。
  const careful = c.heard(CITATION_HINT)
  const compensation = compensationOf(c)
  const letter = c.ok('send_demand_letter')
  const refused = c.results('send_demand_letter').find((r) => r.output.includes('授权'))
  const corrected = c.heard('承诺了诉讼结果')
  return {
    summary: corrected
      ? '公司拖欠工资，您可以解除劳动合同并主张经济补偿；能否全部得到支持，取决于工资流水、劳动合同等证据是否完整。'
      : '公司拖欠工资，您可以解除劳动合同并主张经济补偿，建议尽快固定证据并申请劳动仲裁。',
    facts: [
      `雇主 ${facts.employer}，入职时间 ${facts.hiredAt}，月薪 ${facts.salary} 元`,
      `已欠 ${facts.unpaid} 个月工资`,
    ],
    analysis: [
      {
        issue: '公司拖欠工资是否违法',
        conclusion: '用人单位应当及时足额支付劳动报酬，连续拖欠违反这项义务。',
        citations: cite('《劳动合同法》第三十条'),
      },
      {
        issue: '能否解除劳动合同',
        conclusion: '用人单位未及时足额支付劳动报酬的，劳动者可以通知用人单位解除劳动合同。',
        citations: careful ? cite('《劳动合同法》第三十八条') : [],
      },
      {
        issue: '能否主张经济补偿',
        conclusion: compensation
          ? `可以，按工作年限计算为 ${compensation.months} 个月工资。`
          : '可以，按工作年限计算。',
        citations: cite('《劳动合同法》第四十六条', '《劳动合同法》第四十七条'),
      },
      {
        issue: '仲裁时效',
        conclusion: '劳动关系存续期间的欠薪不受一年时效限制；离职后应在一年内申请仲裁。',
        citations: cite('《劳动争议调解仲裁法》第二十七条'),
      },
    ],
    ...(compensation ? { compensation } : {}),
    precedents: (c.ok('delegate') ?? '').split('\n').filter((l) => l.includes('（虚构示例）')),
    nextSteps: [
      '以书面形式通知公司解除劳动合同，写明理由是未及时足额支付劳动报酬',
      '保留工资流水、劳动合同、考勤记录等证据',
      '向劳动人事争议仲裁委员会申请仲裁，主张欠薪和经济补偿',
      ...(letter ? ['律所已向公司发出催告律师函'] : []),
      ...(refused ? ['如需律所以律所名义发函，请先签署书面授权'] : []),
    ],
    disclaimer: '本意见基于您提供的信息，仅供参考，不构成正式法律意见。',
  }
}

/** 主办律师。 */
export function counsel(input: ModelInput): FakeReply {
  const c = new Conversation(input)

  // 兜底交付：引擎禁用了工具（toolChoice = none），给出阶段性意见。
  if (input.toolChoice === 'none') {
    const basis = c.ok('search_statutes')?.includes('第三十八条')
      ? '根据《劳动合同法》第三十八条，'
      : ''
    return {
      text: `阶段性意见：${basis}公司拖欠工资时您可以解除劳动合同并主张经济补偿；补偿金额还需要核实工作年限后计算。请问您计划哪一天提出解除？`,
    }
  }

  // 1. 先按律所的方法论办：激活 skill，建立计划。
  if (c.can('activate_skill') && !c.called('activate_skill')) {
    return reply(
      '先按劳动争议的办案方法建立计划。',
      ['activate_skill', { name: 'labor-dispute' }],
      plan(0),
    )
  }

  // 客户要看律所内部材料：试一次，被沙箱拒绝后不再尝试。
  if (c.heard('内部') && !c.called('read_client_file')) {
    return reply('看一下律所内部材料。', [
      'read_client_file',
      { path: '../../firm-internal/partners.txt' },
    ])
  }

  // 2. 查明事实：有档案读档案，没有就问委托人。
  const facts = factsOf(c)
  if (!facts) {
    if (c.can('read_dossier') && !c.called('read_dossier')) {
      return reply(
        '先读客户档案和工资流水。',
        ['read_dossier', {}],
        ['read_client_file', { path: 'payroll.txt' }],
      )
    }
    return reply('', [
      'ask_user',
      {
        question:
          '为了计算补偿，请告诉我：入职时间（YYYY-MM-DD）、月工资、已经欠了几个月工资、雇主全称。',
      },
    ])
  }

  // 3. 检索法规。委托人要求保证结果时，这个"模型"会犯一次错：承诺胜诉（守卫会纠正它）。
  if (!c.called('search_statutes')) {
    const promise = c.heard('保证') && !c.heard('承诺了诉讼结果') ? '放心，这类案子保证胜诉。' : ''
    return reply(
      `${promise}检索相关法规。`,
      ['search_statutes', { query: '拖欠 解除 经济补偿 仲裁' }],
      plan(1),
    )
  }

  // 4. 委托案例研究员检索类案。
  if (c.can('delegate') && !c.called('delegate')) {
    return reply(
      '请案例研究员查类案。',
      [
        'delegate',
        { agent: 'case-researcher', task: '检索欠薪后劳动者解除合同并主张经济补偿的类案' },
      ],
      plan(2),
    )
  }

  // 5. 计算经济补偿。
  if (!c.called('calc_compensation')) {
    return reply(
      '计算经济补偿。',
      [
        'calc_compensation',
        { monthlySalary: facts.salary, hiredAt: facts.hiredAt, leftAt: LEAVE_DATE },
      ],
      plan(3),
    )
  }

  // 6. 委托人要求发律师函：第一次忘了写收件人（hook 会拒绝），补上后再发，发函要律师审批。
  if (c.heard('律师函') && c.can('send_demand_letter')) {
    const tries = c.results('send_demand_letter')
    const amount = (compensationOf(c)?.amount ?? 0) + facts.salary * facts.unpaid
    if (tries.length === 0)
      return reply('起草律师函。', ['send_demand_letter', { amount, deadlineDays: 15 }])
    if (tries.length === 1 && tries[0]!.output.includes('收件人')) {
      return reply('补上收件人。', [
        'send_demand_letter',
        { recipient: facts.employer, amount, deadlineDays: 15 },
      ])
    }
  }

  // 7. 交付。文字交付（快问快答）直接回答；正式咨询提交意见书。
  if (!c.can('submit')) {
    return {
      text: '简要答复：公司拖欠工资时您可以解除劳动合同并主张经济补偿，建议尽快申请劳动仲裁。',
    }
  }
  return reply(
    '意见书已整理。依据《劳动合同法》，“用人单位应当按照劳动合同约定和国家规定，向劳动者及时足额支付劳动报酬”。',
    ['submit', opinionOf(c, facts)],
  )
}

/** 案例研究员（子 agent）：经 MCP 案例库检索类案。 */
export function researcher(input: ModelInput): FakeReply {
  const c = new Conversation(input)
  if (input.toolChoice === 'none') return { text: '类案检索没有完成。' }
  const tool = input.tools.find((t) => t.name.endsWith('__search_cases'))?.name
  if (!tool && c.can('search_tool') && !c.called('search_tool')) {
    return reply('查找案例检索工具。', ['search_tool', { query: '劳动争议 类案' }])
  }
  if (tool && !c.called(tool)) return reply('检索类案。', [tool, { keyword: '工资 拖欠' }])
  const cases = (tool ? (c.ok(tool) ?? '') : '')
    .split('\n')
    .filter((l) => l.includes('（虚构示例）'))
  return { text: cases.length ? `类案参考：\n${cases.join('\n')}` : '没有检索到类案。' }
}

/** 复核模型：完成审查和记忆压缩用的辅助模型。演示里总是判定完成。 */
export function reviewer(): FakeReply {
  return { text: JSON.stringify({ complete: true, confidence: 0.9, missing: [] }) }
}
