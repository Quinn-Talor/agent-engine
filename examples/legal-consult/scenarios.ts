// 演示场景：每个场景是一次（或两次）真实的咨询运行，覆盖平台上的一组组件。

import { text, type RunEvent, type RunResult } from '@talor/agent-engine'
import { legalFallback } from './deliverable.ts'
import { consultationTask, type LegalPlatform } from './platform.ts'

export interface ConsultationRun {
  runId: string
  result: RunResult
  events: RunEvent[]
}

export interface Scenario {
  id: string
  title: string
  /** 这个场景演示的组件。 */
  shows: string[]
  run(p: LegalPlatform): Promise<ConsultationRun[]>
}

const ARREARS = '我在星河科技有限公司工作，公司已经拖欠我三个月工资，'

export const SCENARIOS: Scenario[] = [
  {
    id: 'standard',
    title: '标准咨询：欠薪三个月，想辞职并拿补偿',
    shows: [
      'skill 方法论',
      '计划',
      '客户档案能力',
      '按阶段呈现工具',
      '能力包（法规检索 + 补偿计算）',
      '子 agent 经 MCP 检索类案',
      '结构化意见书与领域校验退回',
      '引用核对、引文核对、完成审查',
      '律所强制验收（免责声明）',
    ],
    run: async (p) => [
      await p.consult(
        consultationTask(`${ARREARS}我想辞职并拿到补偿，应该怎么做？`, { clientId: 'C-1024' }),
      ),
    ],
  },
  {
    id: 'follow-up',
    title: '散客咨询：缺事实先追问，补充后接着做',
    shows: ['意图工具 ask_user', '等待委托人', '会话：引擎从会话日志推导下一轮的前文（多轮）'],
    run: async (p) => {
      const session = 'walk-in-follow-up'
      const question = '公司拖欠我工资，我想申请劳动仲裁，能拿回多少？'
      const first = await p.consult(consultationTask(question), { session })
      const answer = '入职时间 2021-03-01，月薪 12000 元，已欠 3 个月工资，雇主是星河科技有限公司。'
      return [first, await p.consult(consultationTask(answer), { session })]
    },
  },
  {
    id: 'conflict',
    title: '利益冲突：对方是本所客户，咨询被拦下',
    shows: ['动态须知拦下运行（利益冲突审查）'],
    run: async (p) => [
      await p.consult(
        consultationTask('我要起诉蓝湾物流有限公司拖欠工资。', {
          opposingParty: '蓝湾物流有限公司',
        }),
      ),
    ],
  },
  {
    id: 'letter',
    title: '发律师函：hook 校验、客户授权、律师审批',
    shows: [
      'Claude Code hook（PreToolUse）',
      '客户授权权限规则',
      '风险审批',
      '律师复核审批人',
      '副作用工具',
    ],
    run: async (p) => [
      await p.consult(
        consultationTask(`${ARREARS}请律所给公司发一封律师函催告，再告诉我怎么维权。`, {
          clientId: 'C-1024',
          clientConsent: true,
        }),
      ),
    ],
  },
  {
    id: 'letter-without-consent',
    title: '发律师函：客户没有授权，发函被拒',
    shows: ['自定义权限规则拒绝', '模型据拒绝理由调整意见书'],
    run: async (p) => [
      await p.consult(
        consultationTask(`${ARREARS}请律所给公司发一封律师函催告，再告诉我怎么维权。`, {
          clientId: 'C-1024',
          clientConsent: false,
        }),
      ),
    ],
  },
  {
    id: 'promise',
    title: '执业规范：模型承诺胜诉，被守卫纠正',
    shows: ['执行环境守卫（计数守卫搭的"不得承诺结果"）', '纠偏消息'],
    run: async (p) => [
      await p.consult(
        consultationTask(`${ARREARS}我想申请仲裁。你能保证我一定能赢吗？`, { clientId: 'C-1024' }),
      ),
    ],
  },
  {
    id: 'stale-dossier',
    title: '档案变更：运行中同事改了档案，按旧事实的咨询停止',
    shows: ['能力自带的守卫', '先告知后终止'],
    run: async (p) => {
      // 准备环节读一次，read_dossier 再读时"同事刚好改了档案"。
      p.dossiers.simulateEditOnRead('C-1024', 2)
      return [
        await p.consult(consultationTask(`${ARREARS}我想辞职并拿到补偿。`, { clientId: 'C-1024' })),
      ]
    },
  },
  {
    id: 'quick-answer',
    title: '快问快答：任务覆盖交付物，步数用完走兜底',
    shows: ['任务覆盖 Agent 的默认交付物（文字）', '预算（步数）', '自定义兜底说明', '阶段性交付'],
    run: async (p) => [
      await p.consult(
        consultationTask('快问一下：公司拖欠工资，我可以直接辞职吗？', {
          clientId: 'C-1024',
          maxSteps: 3,
          deliverable: { output: text(), checks: [], fallback: legalFallback() },
        }),
      ),
    ],
  },
  {
    id: 'sandbox',
    title: '越权读档：想看律所内部材料，被沙箱拒绝',
    shows: ['工作区沙箱（敏感路径）'],
    run: async (p) => [
      await p.consult(
        consultationTask(`${ARREARS}顺便看看律所内部的会议纪要里怎么评价我的案子。`, {
          clientId: 'C-1024',
        }),
      ),
    ],
  },
]
