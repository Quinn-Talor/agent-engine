// 组件契约：共用部分与各槽位组件（设计 §9）。

import type { Clock, JsonValue, LogLevel, ModelMessage, Segment, TaskScope } from './common.js'
import type {
  FinishReason,
  ModelRef,
  NormalizedUsage,
  SideModelRequest,
  SideModelResponse,
} from './model.js'
import type { ToolDef, ToolEffect, ToolCallView } from './tool.js'

// ── 共用部分（§9.1） ─────────────────────────────────────────────

export interface Component {
  id: string
  version: string
  mode?: 'active' | 'shadow'
  /** 可序列化的配置，进入所属对象指纹的配置哈希（方案 D14）。 */
  config?: JsonValue
}

export interface RunInfo {
  runId: string
  parentRunId?: string
  rootRunId: string
  environment: { name: string; principalReachable: boolean }
  /** `version` 是可选的业务标签（设计 §1.4）。 */
  agent: { id: string; version?: string }
  task: {
    subject?: string
    tags?: Record<string, string>
    scope?: TaskScope
    context?: Readonly<Record<string, JsonValue>>
    /** 任务输入的文本（执行器填写），供诊断等组件使用。 */
    input?: string
    /** 任务目标：`TaskDef.goal`，缺省为任务输入的前 200 字；纠偏消息引用它。 */
    goal?: string
  }
  model: { ref: ModelRef; contextLimit: number }
}

export interface ComponentCtx {
  clock: Clock
  random: () => number
  /** 记为 `external_call`，计入预算；监督开销超限时返回 undefined。 */
  callModel(req: SideModelRequest): Promise<SideModelResponse | undefined>
  /** 其他外部调用，记为 `external_call`；重放时读日志（方案 D12 新增 `opts.kind`）。 */
  record<T>(name: string, fn: () => Promise<T>, opts?: { kind?: 'record' | 'hook' }): Promise<T>
  /** 写诊断日志，不进运行日志。 */
  log(level: LogLevel, message: string, detail?: unknown): void
  /** 取得能力宿主，例如 hook 执行器；宿主不存在时抛错（方案 D12）。 */
  host<T>(kind: string): T
  /** 所属运行的取消信号：取消随时生效（设计 §3.1），交给 hook 等外部执行。 */
  signal: AbortSignal
  /** 模型的窗口与输出上限；不写 ref 时为运行的模型，不认识的模型返回 undefined。 */
  modelLimits(ref?: ModelRef): { contextLimit: number; maxOutputTokens: number } | undefined
}

// ── 工具呈现（§9.2） ────────────────────────────────────────────

export interface ToolboxState {
  step: number
  prepared: ReadonlyArray<{
    name: string
    capability: string
    exposure: 'eager' | 'deferred'
    /** 工具描述，供 search_tool 一类的呈现方式检索。 */
    description?: string
  }>
  calls: ReadonlyArray<{ step: number; name: string }>
}

export interface Exposure extends Component {
  /** 呈现方式需要的系统工具，例如 search_tool。 */
  tools?: ToolDef[]
  start(run: RunInfo, ctx: ComponentCtx): { visible(state: ToolboxState): string[] }
}

// ── 记忆（§9.3） ───────────────────────────────────────────────

export interface MemoryState {
  step: number
  history: ModelMessage[]
  transcript: ModelMessage[]
  contextLimit: number
  /** 输入上限：模型窗口减去输出预留；估算达到它就不调用模型（I7），压缩的各条线按它算。 */
  inputLimit: number
  /** 须知、指令、能力说明、任务输入、尾部占用的 token。 */
  fixedTokens: number
  estimate(messages: ModelMessage[]): number
  /** 会话的一轮：history 第一条是带入的摘要时，它的正文；接着合并，不要当成普通消息再总结一遍。 */
  summary?: string
  /** history 里每一轮的起点下标（升序），切以前各轮时按轮切；不带会话的运行为空。 */
  turnStarts: number[]
}

/**
 * 记忆的决定（设计 §9.3）：视图由引擎按它渲染（`renderView`），记忆不直接给出消息。
 * `compaction`：把 history + 运行记录连起来的前 `upTo` 条换成摘要；切点必须落在成对边界上。
 * 每一步都给出当时生效的压缩，不写表示不压缩。
 */
export interface MemoryView {
  compaction?: { upTo: number; summary: string }
  /** 本步附在尾部的提示，例如压缩暂时不可用；不进运行记录。 */
  notice?: string
}

export interface Memory extends Component {
  start(run: RunInfo, ctx: ComponentCtx): { recall(state: MemoryState): Promise<MemoryView> }
}

// ── 观察、意见、干预（§9.7） ────────────────────────────────────

/** 确定性错误重试也不会变；瞬时错误可能下次就好。 */
export type ErrorClass = 'deterministic' | 'transient'

export interface StepToolFact {
  name: string
  capability: string
  inputHash: string
  outputHash: string
  ok: boolean
  errorCode?: string
  /** 只在失败时有。 */
  errorClass?: ErrorClass
  /** 有副作用的调用失败了，但可能已经执行（结果未知）。 */
  possiblyExecuted?: true
  effect: ToolEffect
  durationMs: number
  blocked: boolean
  /** 输入的开头（JSON，最多 200 字），供顾问使用。 */
  inputPreview?: string
  /** 模型看到的输出正文的开头（最多 200 字），由评估环节解析 blob 后写入。 */
  outputPreview?: string
  /** 轮询类工具：封路与无新信息守卫不统计。 */
  repeatable?: boolean
  /** 调用的是意图工具（finish、submit 等）。 */
  intentTool?: true
}

export interface StepFacts {
  step: number
  text: string
  toolCalls: StepToolFact[]
  allToolsFailed: boolean | null
  intent?: { tool: string; kind: 'complete' | 'await_input' | 'stop'; code: string }
  isFinalCandidate: boolean
  newInformation: boolean
  finishReason: FinishReason
  interventions: {
    applied: Array<{ kind: string; source: string }>
    /** 本步撞上的封路：施加者与封路的收尾 code。 */
    violated: Array<{ source: string; code: string }>
  }
  pressure: { context: number; steps: number; time: number; tokens: number; cost: number }
  /** 剩余步数。 */
  stepsLeft?: number
  usage: NormalizedUsage
}

/** 写进 evaluated 的观察就是本步事实。 */
export type Observation = StepFacts

export type Intervention = { hint: { text: string } } | { block: CallBlock }

export type Opinion =
  | { continue: { interventions?: Intervention[] } }
  | { complete: true }
  | { awaitInput: { code: string } }
  | { finalize: { code: string } }
  | { stop: { code: string; message: string } }

export type Verdict = Opinion & { sources: string[] }

// ── 守卫（docs/guard-mechanism.md §3.1） ─────────────────────────

/** 封住一个调用：工具名 + 输入哈希。 */
export interface CallBlock {
  tool: string
  inputHash: string
  /** 撞上封路时的收尾 code。 */
  code: string
  reason: string
  suggest?: string
  /** 封路的理由依赖环境状态（失败、结果不变）：之后有写操作成功时解除。 */
  clearOnChange?: true
}

/** 告知、等待输入或终止；完成只由交付验收判定，守卫不能给出。 */
export type GuardOpinion = { detail?: string } & (
  | { warn: { problem: string; suggest?: string; block?: CallBlock[] } }
  | { awaitInput: { code: string } }
  | { end: { as: 'finalize' | 'stop'; code: string } }
)

/** 看本步事实、记自己的账、给出意见；运行内状态放在 start 返回的实例里。 */
export interface Guard extends Component {
  /** 出错或超时时：'ignore'（默认）视为没有意见，'stop' 停止运行。 */
  onError?: 'ignore' | 'stop'
  start(
    run: RunInfo,
    ctx: ComponentCtx,
  ): { check(facts: StepFacts): GuardOpinion | undefined | Promise<GuardOpinion | undefined> }
}

/** 按归属分组的守卫；来源前缀即归属：`task:`、`environment:`、`capability:`、`engine:`。 */
export interface GuardGroups {
  task?: readonly Guard[]
  environment?: readonly Guard[]
  capability?: readonly Guard[]
  engine?: readonly Guard[]
}

// ── 输出契约、兜底与验收（§9.8、§9.9） ─────────────────────────

/** 语料：任务输入 + history + 工具输出中的 shown（设计 §6.3）。 */
export interface Corpus {
  sources: ReadonlyArray<{
    origin: 'input' | 'history' | 'tool'
    text: string
    callId?: string
    /** 工具来源：工具名、副作用类型、是否出错，供完成审查等验收使用。 */
    toolName?: string
    effect?: ToolEffect
    isError?: boolean
  }>
}

export interface Candidate {
  step: number
  text?: string
  output?: unknown
  observation: Observation
}

export interface OutputContract extends Component {
  kind: 'text' | 'structured'
  /**
   * 结构化交付时提供提交工具：必须带 `semantics.intent: { kind: 'complete' }`，交付环节才把它的
   * 参数当作交付内容（`candidate.output`）。
   */
  tools?: ToolDef[]
  /**
   * 结构化交付的 schema（例如 zod）：交付环节先用它解析提交的参数（默认值、转换生效），不合格按
   * 输出不合格计入 maxRepairs。不提供时参数原样交给 validate。
   */
  schema?: {
    safeParse(value: unknown): {
      success: boolean
      data?: unknown
      error?: { issues: Array<{ path: PropertyKey[]; message: string }> }
    }
  }
  validate(
    candidate: Candidate,
    ctx: ComponentCtx,
  ): Promise<{ ok: true } | { ok: false; issues: string[]; hint: string }>
  /** 用于兜底交付的文本。 */
  sanitize?(text: string, corpus: Corpus): string
  /** 默认 3。 */
  maxRepairs?: number
}

export interface Fallback {
  /** 按收尾 code，按委托人能否联系上。 */
  instructions: Record<string, { reachable: string; unreachable: string }>
  fixedText: string
}

export type CheckMode = 'gate' | 'annotate' | 'shadow'

/** 验收的 `mode` 取值与其他组件不同（gate / annotate / shadow），因此不继承 `Component.mode`。 */
export interface Check extends Omit<Component, 'mode'> {
  mode: CheckMode
  /** gate 模式下每次运行最多退回几次，默认 1。 */
  maxAttempts?: number
  start(
    run: RunInfo,
    ctx: ComponentCtx,
  ): {
    accept(
      candidate: Candidate,
      corpus: Corpus,
    ): Promise<{ pass: true } | { pass: false; issues: string[]; hint: string }>
  }
}

// ── 权限、委托人、须知与 hook（§9.10） ─────────────────────────

export interface AskRequest {
  summary: string
  risk: 'low' | 'high'
  detail?: { paths?: string[]; reason?: string; input?: string }
}

/**
 * `unavailable`：规则自己没能判断（例如 hook 超时、进程起不来）。照样拒绝，但按暂时性的
 * 故障处理（错误码 PERMISSION_UNAVAILABLE），不当成明确的拒绝。
 */
export type PermitResult = 'allow' | { deny: string; unavailable?: true } | { ask: AskRequest }

export interface PermissionRule extends Component {
  permit(call: ToolCallView, run: RunInfo, ctx: ComponentCtx): Promise<PermitResult>
}

/**
 * 审批的回答：同意或拒绝（可选记住）；或稍后答复（`defer` 写原因）：这次调用不执行，
 * 运行以 `awaiting_input` / `approval_pending` 结束，批准记录由审批人自己保存（设计 §9.10）。
 */
export type ApprovalAnswer =
  | { approved: boolean; remember?: { scope: 'session' | 'always'; pattern?: string } }
  | { defer: string }

export interface Approver {
  /** "本会话记住"由实现按 run.task.subject 区分（会话的一轮缺省为会话 id）。 */
  approve(
    req: AskRequest & { callId: string; toolName: string },
    run: RunInfo,
  ): Promise<ApprovalAnswer>
}

export interface NoticeProvider extends Component {
  /** 返回 `{ block }` 表示拦下这次运行（例如 UserPromptSubmit hook 拒绝），运行以 stopped / notice_blocked 结束。 */
  provide(run: RunInfo, ctx: ComponentCtx): Promise<Segment[] | { block: string }>
}

export interface HookSpec {
  event:
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'PreToolUse'
    | 'PostToolUse'
    | 'Stop'
    | 'SubagentStop'
    | 'PreCompact'
    | 'Notification'
  matcher?: string
  command: string
  /** 默认 10 秒。 */
  timeoutMs?: number
  source?: string
}
