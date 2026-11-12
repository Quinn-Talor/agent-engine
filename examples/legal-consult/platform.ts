// 装配律所的法务咨询平台。按业务对象组织配置：
//   引擎（平台服务）→ 执行环境（律所的规矩）→ Agent（谁来做）→ 任务（这次做什么）。
// 每个对象只放属于它的东西：换模型改引擎，改规矩改执行环境，改方法论改 skill，改交付标准改交付物。

import { fileURLToPath } from 'node:url'
import {
  adaptHooks,
  bundle,
  compactingMemory,
  createEngine,
  defineAgent,
  defineTask,
  hookRunner,
  intents,
  mcp,
  mcpHost,
  memoryArchive,
  modelHub,
  otelExporter,
  parseSkill,
  planning,
  riskApproval,
  skill,
  standardFallback,
  standardGuards,
  subagent,
  text,
  thresholdGuard,
  tool,
  workspaceSandbox,
  type Agent,
  type ArchiveStore,
  type Deliverable,
  type Engine,
  type Environment,
  type JsonValue,
  type LogEntry,
  type OtelSpan,
  type RunEvent,
  type RunResult,
  type Task,
} from '@talor/agent-engine'
import { fakeModel } from '@talor/agent-engine/testing'
import { auditTrail } from './audit.ts'
import { clientDossier } from './client-dossier.ts'
import { legalOpinion } from './deliverable.ts'
import { DossierStore, SAMPLE_DOSSIERS } from './domain.ts'
import {
  PRACTICE_SCOPE,
  clientConsentRule,
  conflictCheck,
  disclaimerRequired,
  dutyNotice,
  lawyerReview,
  noOutcomePromise,
  type ReviewRecord,
} from './firm-rules.ts'
import { counsel, researcher, reviewer } from './lawyer-model.ts'
import { stagedExposure } from './toolbox.ts'
import { calcCompensation, searchStatutes, sendDemandLetter, type Letter } from './tools.ts'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export const COUNSEL_MODEL = 'counsel:v1'
export const RESEARCHER_MODEL = 'researcher:v1'
export const REVIEWER_MODEL = 'reviewer:v1'

/** 凭据库里的值只在解析时出现，不进业务对象，也会从运行日志和诊断日志里脱敏。 */
const SECRETS: Record<string, string> = { 'case-law-token': 'demo-case-law-token' }

export interface LegalPlatform {
  engine: Engine
  /** 律所的咨询执行环境。 */
  consultation: Environment
  counsel: Agent
  researcher: Agent
  archive: ArchiveStore
  dossiers: DossierStore
  /** 已发出的律师函（演示里代替真实的发函系统）。 */
  outbox: Letter[]
  /** 律师复核记录。 */
  reviews: ReviewRecord[]
  /** 审计订阅者写下的办案记录。 */
  audit: string[]
  /** 导出给观测后端的 span（演示里先存下来）。 */
  spans: OtelSpan[]
  logs: LogEntry[]
  /**
   * 开始一次咨询：订阅审计与导出（含子运行），等待结果。给了会话 id 时这次咨询是会话的一轮，
   * 前文由引擎从会话日志推导（多轮对话、接着做）。
   */
  consult(
    task: Task,
    opts?: { session?: string },
  ): Promise<{ runId: string; result: RunResult; events: RunEvent[] }>
  shutdown(): Promise<void>
}

export async function createLegalPlatform(): Promise<LegalPlatform> {
  const dossiers = new DossierStore(SAMPLE_DOSSIERS)
  const outbox: Letter[] = []
  const reviews: ReviewRecord[] = []
  const audit: string[] = []
  const spans: OtelSpan[] = []
  const logs: LogEntry[] = []
  const archive = memoryArchive()

  // ── 引擎：平台服务与运行机制 ──────────────────────────────────────
  const models = modelHub({
    providers: [
      fakeModel({ provider: 'counsel', model: 'v1', replies: [counsel], repeatLast: true }),
      fakeModel({ provider: 'researcher', model: 'v1', replies: [researcher], repeatLast: true }),
      fakeModel({ provider: 'reviewer', model: 'v1', replies: [reviewer], repeatLast: true }),
    ],
    default: COUNSEL_MODEL,
    // 价格（美元 / 百万 token）：有价格才能按费用设预算、算每次咨询的成本。
    pricing: {
      [COUNSEL_MODEL]: { input: 3, output: 15 },
      [RESEARCHER_MODEL]: { input: 0.5, output: 2 },
      [REVIEWER_MODEL]: { input: 0.5, output: 2 },
    },
  })
  const engine = createEngine({
    services: {
      models,
      archive,
      hosts: [mcpHost(), hookRunner()],
      vault: {
        async resolve(ref) {
          const value = SECRETS[ref.secret]
          if (value === undefined) throw new Error(`凭据不存在：${ref.secret}`)
          return value
        },
      },
      logger: { log: (e) => void logs.push(e) },
    },
    // 记忆：视图快放不下时压缩较早的运行记录，摘要交给便宜的复核模型写。
    memory: compactingMemory({ trigger: 0.75, model: REVIEWER_MODEL }),
    // 引擎守卫：标准守卫（封路、失败连击、无新信息、截断、静默推进）。
    guards: standardGuards(),
  })

  // ── 执行环境：律所的规矩 ─────────────────────────────────────────
  // 律所原有的 Claude Code hook 脚本原样接入，翻译成须知、权限、守卫和强制验收。
  const hooks = adaptHooks([
    {
      event: 'PreToolUse',
      matcher: 'send_demand_letter',
      command: `"${process.execPath}" "${here('./hooks/letter-recipient.ts')}"`,
    },
  ])
  const consultation = engine.environment({
    name: 'labor-consultation',
    principal: {
      reachable: true,
      approver: lawyerReview({ reviewer: '李律师', maxAmount: 200_000, log: reviews }),
    },
    notice: [PRACTICE_SCOPE, dutyNotice('李律师'), conflictCheck, ...hooks.notice],
    permissions: [
      // 只能读本案工作区；律所内部材料无论如何都不能读。
      workspaceSandbox({ sensitive: [here('./workspace/firm-internal')] }),
      clientConsentRule,
      riskApproval({ mode: 'ask-high' }),
      ...hooks.permissions,
    ],
    guards: [noOutcomePromise, ...hooks.guards],
    checks: [disclaimerRequired, ...hooks.checks],
    caps: {
      budget: { maxSteps: 30, maxTotalMs: 600_000, maxCost: 1 },
      maxConcurrentRuns: 4,
      approvalTimeoutMs: 60_000,
      delegation: { depth: 2 },
    },
  })

  // ── Agent：谁来做 ────────────────────────────────────────────────
  const researcherAgent = defineAgent({
    id: 'case-researcher',
    instructions: [
      {
        role: 'system',
        parts: [
          {
            type: 'text',
            text: '你是案例研究员，检索劳动争议类案的裁判要旨，只报告检索到的内容。',
          },
        ],
      },
    ],
    // 外部案例库经 MCP 接入；令牌按引用从凭据库解析。MCP 工具默认延后呈现，由标准的搜索呈现按需露出。
    capabilities: [
      mcp({
        name: 'case_law',
        transport: {
          kind: 'stdio',
          command: process.execPath,
          args: [here('./servers/case-law.ts')],
          env: { CASE_LAW_TOKEN: { secret: 'case-law-token' } },
        },
        // 案例库报错（例如令牌无效）都是确定性的：同样的输入不必再试。
        errorClass: { '*': 'deterministic' },
      }),
    ],
    deliverable: { output: text(), checks: [], fallback: standardFallback() },
    model: { prefer: RESEARCHER_MODEL },
  })

  const counselAgent = defineAgent({
    id: 'labor-counsel',
    version: '2025.06',
    instructions: [
      {
        role: 'system',
        parts: [
          {
            type: 'text',
            text: '你是律所的劳动法律师，为劳动者提供初步咨询，最后提交结构化的法律意见书。',
          },
        ],
      },
    ],
    capabilities: [
      intents(),
      planning(),
      skill(await parseSkill(here('./skills/labor-dispute'))),
      bundle({
        id: 'legal-research',
        capabilities: [tool(searchStatutes), tool(calcCompensation)],
      }),
      tool(sendDemandLetter(outbox)),
      clientDossier(dossiers),
      // 子运行的时长不超过父运行剩余的时长（不变量 I12）；两边都没设时引擎给 10 分钟。
      subagent(researcherAgent, {
        description: '检索劳动争议类案',
        budget: { maxSteps: 6 },
      }),
    ],
    toolbox: { exposure: stagedExposure },
    deliverable: legalOpinion(REVIEWER_MODEL),
    model: { prefer: COUNSEL_MODEL },
  })

  const readAll = async (runId: string) => {
    const events: RunEvent[] = []
    for await (const e of archive.read(runId)) events.push(e)
    return events
  }

  return {
    engine,
    consultation,
    counsel: counselAgent,
    researcher: researcherAgent,
    archive,
    dossiers,
    outbox,
    reviews,
    audit,
    spans,
    logs,
    async consult(task, opts = {}) {
      const run = consultation.start(
        counselAgent,
        task,
        opts.session !== undefined ? { session: opts.session } : undefined,
      )
      run.subscribe(auditTrail(audit), { children: true })
      run.subscribe(
        otelExporter({ send: (s) => void spans.push(...s), serviceName: 'legal-consult' }),
        {
          children: true,
        },
      )
      const result = await run.result
      return { runId: run.runId, result, events: await readAll(run.runId) }
    },
    shutdown: () => engine.shutdown(),
  }
}

// ── 任务：这次做什么 ─────────────────────────────────────────────────

/** 任务的守卫：反复检索同一类法规时提醒，再多就收尾。 */
export const noRepeatedResearch = thresholdGuard({
  id: 'no-repeated-research',
  warn: 3,
  end: 5,
  count: () => (facts) => facts.toolCalls.filter((c) => c.name === 'search_statutes').length,
  problem: (_facts, n) => `已经检索了 ${n} 次法规`,
  suggest: '用已经查到的条文继续分析',
})

export interface ConsultationOptions {
  clientId?: string
  /** 客户是否已书面授权以律所名义发函。 */
  clientConsent?: boolean
  /** 对方当事人，用于利益冲突审查。 */
  opposingParty?: string
  /** 覆盖 Agent 的默认交付物，例如快问快答只要文字。 */
  deliverable?: Deliverable
  maxSteps?: number
}

export function consultationTask(question: string, opts: ConsultationOptions = {}): Task {
  const context: Record<string, JsonValue> = {}
  if (opts.clientId) context.clientId = opts.clientId
  if (opts.clientConsent !== undefined) context.clientConsent = opts.clientConsent
  if (opts.opposingParty) context.opposingParty = opts.opposingParty
  return defineTask({
    input: [{ role: 'user', parts: [{ type: 'text', text: question }] }],
    ...(opts.clientId
      ? { scope: { workspace: here(`./workspace/clients/${opts.clientId}`) } }
      : {}),
    context,
    goal: '给出劳动争议的初步法律意见',
    guards: [noRepeatedResearch],
    budget: { maxSteps: opts.maxSteps ?? 20, maxTotalMs: 300_000, maxCost: 0.5 },
    ...(opts.deliverable ? { deliverable: opts.deliverable } : {}),
    subject: opts.clientId ?? 'walk-in',
    tags: { practice: 'labor' },
  })
}
