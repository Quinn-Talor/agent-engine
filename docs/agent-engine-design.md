# Agent 引擎设计（v1.2）

> **状态**：讨论稿，未评审。
> **范围**：Agent 引擎的业务对象、执行流程、扩展架构、稳定性设计，以及它与应用之间的边界。

---

## 0. 定位与原则

### 0.1 定位

应用定义 Agent（谁来做）、组装任务（做什么、在哪做、做到什么程度），在执行环境（组织的规矩）里启动运行。引擎按固定的流程把运行可靠地跑完，返回结果和完整的运行日志。

**承载与使用归引擎，配置与选择归应用。** 引擎不负责：
- 用哪些 MCP 服务器、装哪些插件、给哪个 agent 什么能力；
- 会话的产品层（会话 id 怎么来、谁能访问、会话列表、界面停在哪个分支）、界面、业务数据；会话的上下文（接续与分叉、下一轮的窗口、跨轮压缩、副作用台账）归引擎，见 §3.15；
- prompt 内容、工具的业务实现。

### 0.2 目标

| # | 目标（按优先级） | 怎么达成 |
|---|---|---|
| G1 | 稳定：运行一定会结束；外部依赖和组件的失败有边界、有降级、可恢复 | 不变量（§7）、稳定性设计（§5）、标准监督与验收（§10） |
| G2 | 可预测：输入相同、外部响应相同时，裁决也相同 | 固定流程 + 纯函数核心；组件规约（§4.3） |
| G3 | 可重放 | 运行日志是唯一的事实来源（§6） |
| G4 | 可扩展：业务扩展不需要改引擎 | 流程固定，只开放环节里的组件槽位（§4） |
| G5 | 可观测：每个裁决都能追溯到来源 | 事实、意见、裁决、交付结果都写进日志 |
| G6 | 隔离：与界面、会话、业务、厂商 SDK、存储引擎都隔离 | 端口与适配器；依赖规则由 lint 强制（§14） |

### 0.3 设计原则

| # | 原则 | 含义 |
|---|---|---|
| P1 | 流程固定，组件开放 | 执行流程固定；只开放各环节里的组件槽位 |
| P2 | 面向业务对象 | 配置放在拥有它的业务对象上；流程只是执行视图，不用来组织配置 |
| P3 | 唯一事实来源 | 运行日志是唯一的事实来源；状态、trace、统计、复盘都从它推导 |
| P4 | 事实、意见、裁决分离 | 观察只产生事实，反思只产生意见，判定只产生裁决 |
| P5 | 能力统一 | 模型能做的一切都抽象为能力 |
| P6 | 承载与使用归引擎 | 引擎接收已经确定的能力，负责把它用好 |
| P7 | 失败可控 | 每个外部依赖、每个组件的失败都有边界、有降级、可恢复 |

### 0.4 设计守则

新增对象、配置块或组件时，逐条对照：

| # | 守则 |
|---|---|
| R1 | 每个对象、每个配置块，都能用一句业务语言说清"它是什么" |
| R2 | 同一块里的东西服务同一个职责，并且一起变化 |
| R3 | 同一个槽位最多两个来源，并且来源有业务含义（平台 / 业务、工单 / 组织）。唯一的例外是守卫：监督要同时看工单、组织、能力和平台四方的要求，四个来源按固定顺序收集、按固定优先级合并（§3.10），不靠来源多少决定结果 |
| R4 | 不按技术阶段组织配置；流程只是执行视图 |
| R5 | 策略跟着拥有它的对象走：韧性跟依赖走，限额跟拥有者走 |
| R6 | 关系到不变量的东西不开放 |
| R7 | 外部机制通过适配器翻译成已有概念，不新增特殊字段 |
| R8 | 组件只负责量化或判断，处理方式归决策方 |

### 0.5 命名

| 名称 | 代码 | 指什么 |
|---|---|---|
| 引擎 | `Engine`，包名 `agent-engine` | 平台：平台服务 + 运行机制（记忆、监督） |
| 执行环境 | `Environment` | 组织的规矩：委托人、须知、权限、守卫、上限 |
| Agent | `Agent` | 角色：身份与指令、能力、工具箱、默认交付物、模型偏好 |
| 任务 | `Task` | 工单：输入、背景、作业范围、交付物、目标、守卫、预算 |
| 运行 | `Run` | 一次执行：步、观察、意见、裁决、交付记录、结果、日志 |
| 能力 | `Capability` | Agent 能做的一件事 |
| 交付物 | `Deliverable` | 交什么、怎么验收、做不完时交什么 |
| 委托人 | `Principal` | Agent 替谁做事：能否联系上，怎么审批 |
| 记忆 | `Memory` | 运行的工作记忆：视图放不下时怎么压缩 |
| 监督 | `Supervision` | 发现运行跑偏并纠正：事实 → 守卫 → 裁决（docs/guard-mechanism.md） |
| 环节 / 槽位 | `Stage` / slot | 固定流程中的一个环节，以及环节里开放给组件的位置 |
| 核心 / 执行器 | `core/` / `executor/` | 模块：纯函数部分 / 驱动运行的部分，不是对象 |

---

## 1. 业务对象

### 1.1 对象总览

| 对象 | 职责 | 组成 | 不负责 | 生命周期 |
|---|---|---|---|---|
| **引擎** | 提供平台服务，规定运行怎么被执行 | 平台服务；运行机制：记忆、监督 | 角色、工单、组织规矩 | 应用启动到退出 |
| **执行环境** | 规定在这里工作的所有 agent 必须遵守什么 | 委托人、须知、权限、守卫、上限 | 角色内容、工单内容、平台机制 | 长期、不可变；设置变化时重新创建 |
| **Agent** | 描述谁来做 | 身份与指令、能力、工具箱、默认交付物、模型偏好与要求 | 执行；保存运行状态；规矩；平台机制 | 长期；版本由内容决定 |
| **任务** | 描述这次做什么、在哪做、做到什么程度 | 输入、背景、作业范围、交付物、目标、守卫、预算、归属 | 改变角色、规矩或平台机制 | 一次运行 |
| **运行** | 一次执行的全过程和记录 | 步、观察、意见、裁决、干预、交付记录、结果、日志 | 跨运行的状态 | 一次 |

### 1.2 引擎

**平台服务**：跨执行环境共享，每个服务自带韧性策略。

| 服务 | 是什么 | 自带的韧性 |
|---|---|---|
| 模型库 `ModelHub` | 模型提供方、默认模型、价格表 | 按提供方的并发上限；按模型的熔断 |
| 能力宿主 `CapabilityHost` | MCP 连接池、skill 宿主、委托调度、hook 执行器；可以注册新的宿主 | MCP 按服务器熔断；连接等待上限 |
| 运行档案 `Archive` | 运行日志的存储、查询、保留、回放 | — |
| 凭据库 `Vault` | 按引用解析凭据 | — |
| 时钟 `Clock` | 统一时间来源 | — |
| 诊断日志 `Logger` | 引擎和组件的诊断输出；不进运行日志，不参与回放（§6.6） | — |
| 准入 `Admission` | 全局并发运行数、排队 | 排队超时 |

**运行机制**：对所有运行一视同仁，由平台提供。

| 机制 | 是什么 | 组成 | 起作用的环节 |
|---|---|---|---|
| 记忆 | 运行的工作记忆：视图放不下时，按策略压缩 history 和运行记录；任务输入永远原样保留 | 记忆策略 `Memory`（1 个） | ① 组装 |
| 监督 | 发现运行跑偏并纠正：守卫看本步事实、记自己的账、给出意见，引擎按固定顺序合并（详见 docs/guard-mechanism.md） | 守卫 `Guard`（多个）：引擎默认 `standardGuards()` | ④ 观察、⑤ 反思 |

一个引擎只有一套记忆与一组引擎守卫。业务通过这些渠道影响运行机制：
- 任务、执行环境、能力都可以带守卫，与引擎守卫一起参与裁决，来源前缀分别是 `task:`、`environment:`、`capability:`、`engine:`；
- 场景差异（委托人能否联系上、模型窗口大小）由组件读取运行信息自行适配。

记忆和守卫中需要调用模型的部分（压缩摘要、可选顾问 `modelAdvisor`），默认使用运行的模型，可以在组件参数里单独指定。

### 1.3 执行环境

| 部分 | 是什么 | 起作用的环节 |
|---|---|---|
| 委托人 `principal` | Agent 替谁做事。`reachable`：运行中能否联系上；`approver`：怎么审批 | 准备（联系不上时排除提问类能力）、③ 行动（审批）、交付（选择兜底说明的版本） |
| 须知 `notice` | 组织准则，排在所有指令之前；可以是静态内容，也可以在准备环节动态生成 | ① 组装 |
| 权限 `permissions` | 每个工具调用能不能执行 | ③ 行动 |
| 守卫 `guards` | 组织对执行过程的要求，来源 `environment:<id>` | ④ 观察、⑤ 反思 |
| 强制验收 `checks` | 组织对所有交付物的质量要求 | 交付 |
| 上限 `caps` | 预算上限、并发运行数、每次运行的工具并发、委托的深度与次数、审批等待 | 受理、③ 行动 |

### 1.4 Agent

| 部分 | 是什么 | 起作用的环节 |
|---|---|---|
| 身份与指令 | id、可选的业务版本标签、角色指令；统计和回放按指纹区分（§6.4） | ① 组装 |
| 能力 `capabilities` | Agent 能做的事：工具、MCP、skill、子 agent、规划、与委托人沟通 | 准备、③ 行动 |
| 工具箱 `toolbox` | 能力准备后得到的全部工具，以及它们怎么呈现给模型（哪些先露出，哪些按需展开） | ① 组装 |
| 默认交付物 `deliverable` | 默认交什么、怎么验收、做不完时交什么；任务可以覆盖 | 交付 |
| 模型偏好与要求 `model` | 偏好哪个模型；对视觉、最小上下文窗口等的要求；主模型调用的采样参数（temperature、topP） | 受理、② 推理 |

### 1.5 任务

| 部分 | 是什么 | 起作用的环节 |
|---|---|---|
| 输入 `input` | 本次要做的事：用户消息与附件，或任务说明 | ① 组装 |
| 背景 `history` | 之前的对话，可以包含上次运行的压缩摘要；会话的一轮不能给，前文由引擎推导（§3.15） | ① 组装 |
| 易变信息 `volatile` | 日期等每次都可能变的信息，只放在视图尾部 | ① 组装 |
| 作业范围 `scope` | 在哪儿干活，例如工作区 | ③ 行动（权限、工具） |
| 业务上下文 `context` | 这张工单的业务参数，例如档案 id、判断时点。引擎不解释，只读地交给工具和组件 | 准备、③ 行动、⑤ 反思、交付 |
| 交付物 `deliverable` | 覆盖 Agent 的默认交付物 | 交付 |
| 目标 `goal` | 纠偏消息里引用的任务目标；缺省为任务输入的前 200 字 | ⑤ 反思 |
| 守卫 `guards` | 这张工单的业务守卫，例如"档案版本变了就作废"，来源 `task:<id>` | ④ 观察、⑤ 反思 |
| 预算 `budget` | 步数、时长、token、费用；不能超过执行环境的上限 | 受理、全程 |
| 归属 `subject`、`tags` | 会话 id、档案 id（会话的一轮缺省为会话 id）；`retryOf` 等标签 | 查询、统计 |

### 1.6 运行

运行由 `environment.start(agent, task, { model })` 创建。对外提供句柄（`subscribe`、`steer`、`abort`、`result`），对内产出运行日志。记忆和监督作用在每一次运行上。

### 1.7 依赖与边界

```
应用 ──创建──▶ 引擎 ──创建──▶ 执行环境
应用 ──定义──▶ Agent、任务
应用 ──启动──▶ environment.start(agent, task, { model }) ──产出──▶ 运行 ──▶ 应用订阅、读取

运行 ──使用──▶ 引擎的平台服务和运行机制
运行 ──遵守──▶ 执行环境
运行 ──读取──▶ Agent、任务（只读）
```

1. **依赖单向**：应用依赖引擎；引擎不依赖应用。
2. **Agent 和任务是被动的**：不调用引擎，不保存状态；同一个 Agent 可以同时跑多个任务。
3. **运行状态只在运行日志里**：引擎和执行环境不在两次运行之间携带业务状态。
4. **共享资源只在引擎里**：连接池、熔断、准入跨执行环境共享；执行环境之间互不影响。

| | 运行内（引擎负责） | 运行之间（应用负责） |
|---|---|---|
| 循环 | 多步执行、工具调用、子运行 | 多轮对话：每条用户消息开启一次新运行 |
| 纠偏 | 纠偏消息、封路、收尾、停止 | 重跑：开启新运行，可以换模型、改指令 |
| 不变 | Agent、任务、执行环境、运行机制、能力快照、模型在运行中都不变（I14） | 要变，就开启新运行 |
| 状态 | 只在本次运行的日志里 | 会话的下一轮由引擎从会话日志推导带入（§3.15）；不带会话时由应用显式带入 history |
| 委托人 | 中途引导、审批、中止 | 回复"等待输入"、点重试 |
| 多 agent | 委托能力发起子运行：独立日志，预算和取消挂在父运行下 | 编排多个独立运行 |

### 1.8 模型解析

受理时按顺序确定模型：`start` 时的指派 > Agent 的模型偏好 > 模型库的默认模型。

解析出的模型必须满足两项要求：
- Agent 的要求（视觉、最小上下文窗口等）；
- 交付物的要求（结构化交付需要模型支持工具调用）。

不满足时，运行以 `failed` / `model_unsuitable` 结束。实际使用的模型写入 `run_started`。

子运行的模型按顺序确定：子 agent 的模型偏好 > 父运行的模型 > 模型库的默认模型，同样要满足子 agent 的要求。

---

## 2. 对外接口

```ts
// —— 引擎 ——
function createEngine(config: EngineConfig): Engine

interface EngineConfig {
  services: {
    models: ModelHub                  // §8.1
    hosts?: CapabilityHost[]          // 总带 skill 宿主和委托调度；传入的加在后面，同一种类的替换默认的（§8.3）
    archive?: Archive                 // 默认内存实现；持久化用 sqliteArchive（§8.5）
    vault?: Vault                     // 不提供时，带凭据引用的能力无法准备
    clock?: Clock
    logger?: Logger                   // 诊断日志（§6.6）；默认输出到控制台
    admission?: { maxConcurrentRuns?: number; queueTimeoutMs?: number }
  }
  memory?: Memory                     // 记忆策略；默认 compactingMemory()
  guards?: Guard[]                    // 引擎守卫（来源 engine:<id>）；默认 standardGuards()，[] 表示不用标准守卫
}
interface Engine {
  environment(config: EnvironmentConfig): Environment
  readonly fingerprint: string        // 记忆与引擎守卫的指纹（§6.4）
  interrupted(): Promise<RunSummary[]>   // 本次启动时补齐结尾的中断运行（§3.12），由应用决定是否接着做
  health(): EngineHealth
  onHealth(fn: (h: EngineHealth) => void): () => void
  shutdown(): Promise<void>
}

// —— 执行环境 ——
interface EnvironmentConfig {
  name: string                        // 写入日志，可以按它查询、设置保留策略
  principal: { reachable: boolean; approver?: Approver }
  notice?: Array<Segment | NoticeProvider>
  permissions?: PermissionRule[]
  guards?: Guard[]                    // 执行环境的守卫（来源 environment:<id>）
  checks?: Check[]                    // 强制验收
  caps?: Caps                         // §3.14
}
interface Environment {
  readonly name: string
  readonly fingerprint: string
  start(agent: Agent, task: Task, assignment?: { model?: ModelRef; runId?: string }): Run
}

// —— Agent ——
function defineAgent(def: AgentDef): Agent      // 校验、计算指纹
interface AgentDef {
  id: string
  version?: string                    // 业务版本标签；统计和回放以指纹为准
  instructions: Segment[]
  capabilities?: Capability[]
  toolbox?: { exposure?: Exposure }   // 默认 searchExposure()
  deliverable?: Deliverable           // 默认 { output: text(), checks: [completionReview()], fallback: standardFallback() }
  model?: { prefer?: ModelRef; requires?: ModelRequirements; settings?: ModelSettings }
}
// 采样参数：只用于主模型调用与兜底调用，进入 Agent 指纹；推理档位与厂商参数在模型配置里（§8.1）
interface ModelSettings { temperature?: number /* 0–2 */; topP?: number /* (0, 1] */ }
interface Agent extends Readonly<AgentDef> { readonly fingerprint: string }

// —— 任务 ——
function defineTask(def: TaskDef): Task
interface TaskDef {
  input: Segment[]
  history?: ModelMessage[]            // 要求工具调用成对
  volatile?: Segment[]
  scope?: { workspace?: string }
  context?: Record<string, JsonValue> // 业务上下文：引擎不解释，只读地交给工具和组件，计入任务指纹
  deliverable?: Deliverable           // 整体覆盖 Agent 的默认交付物
  goal?: string                       // 任务目标，纠偏消息引用；缺省为任务输入的前 200 字
  guards?: Guard[]                    // 任务的守卫（来源 task:<id>）
  budget?: Budget
  subject?: string
  tags?: Record<string, string>
}
interface Deliverable {
  output: OutputContract              // §9.8
  checks?: Check[]                    // §9.9
  fallback?: Fallback                 // §9.8
}
interface Budget {
  maxSteps?: number; maxTotalMs?: number; finalizeReserveMs?: number
  maxInputTokens?: number
  maxCost?: number                    // 需要模型库里有该模型的价格
}
type Segment = { role: 'system' | 'user'; parts: Array<TextPart | ImagePart | FilePart> }

// —— 运行 ——
interface Run {
  readonly runId: string
  readonly result: Promise<RunResult>
  subscribe(sub: { onEvent?(e: RunEvent, run: { runId }): void | Promise<void>;
                   onNotice?(n: Notice, run: { runId }): void },
            opts?: { fromSeq?: number; children?: boolean }): () => void
            // 先从日志回放，再接上实时事件；children 时也接收子运行（及其子运行）的事件和通知，用 runId 区分
  steer(text: string): void
  abort(reason?: string): void
}
interface RunResult {
  runId: string
  status: 'completed' | 'awaiting_input' | 'finalized' | 'stopped' | 'failed' | 'aborted'
  code?: string                       // §3.12
  text?: string
  output?: unknown                    // 结构化交付通过校验的结果
  intent?: { tool: string; input: unknown }   // 以意图结束时，该调用的参数
  error?: { code: ErrorCode; message: string; retryable: boolean }
  quality?: QualityReport             // 验收未解决的问题和标注结果
  model: ModelRef
  usage: NormalizedUsage              // 主模型、记忆、监督、工具、子运行分开统计
  cost?: number
  steps: number
  toolCalls: number
}
```

---

## 3. 执行流程

流程固定：环节不能增删，顺序不能调换。每个环节里有少数开放的槽位，组件只能装进这些槽位。

### 3.1 总图

```
受理 → 准备 → 步循环 ─────────────────────────────────────────→ 交付 → 结束
              │ ① 组装 → ② 推理 → ③ 行动 → ④ 观察 → ⑤ 反思 → ⑥ 判定 │
              │   判定 = 继续              → 下一步                  │
              │   判定 = 完成              → 交付（正常路径）         │
              │   判定 = 收尾              → 交付（兜底路径）         │
              │   判定 = 等待输入 / 停止   → 结束                     │
              └──────────────── 交付验收不通过：带提示回到下一步 ←────┘
```

贯穿全程的三条规则：

- 每个环节的结果先写日志，再往下推进（I13）。
- 取消随时生效（§3.14）。
- 委托人的引导随时可以到达，在下一步的 ① 生效（§10.5）。

### 3.2 环节与槽位

| 环节 | 内置（不开放） | 槽位 | 数量 | 组件来源 |
|---|---|---|---|---|
| 受理 | 校验、模型解析、准入排队 | — | — | — |
| 准备 | 准备能力、冻结快照、同类合并、不可用排除、动态须知 | 能力 | 多个 | Agent；交付物（结构化交付时提供 submit） |
| ① 组装 | 视图布局、只追加、超限检查 | 记忆 | 1 | 引擎 |
| | | 工具呈现 | 1 | Agent 的工具箱 |
| ② 推理 | 并发、熔断、重试、错误分类 | — | — | — |
| ③ 行动 | 流水线顺序、封路、副作用与幂等 | 权限规则 | 多个 | 执行环境 |
| | | 审批 | 0–1 | 执行环境的委托人 |
| ④ 观察 + ⑤ 反思 | 基础事实；先告知后终止、引导后重来、出错降级；预算守卫；纠偏消息 | 守卫 | 多个 | 任务、执行环境、能力、引擎 |
| ⑥ 判定 | 全部 | — | — | — |
| 交付 | 顺序、次数上限、三级兜底 | 输出契约 | 1 | 交付物（任务的覆盖 Agent 的） |
| | | 验收 | 多个 | 交付物；执行环境的强制验收 |
| 结束 | 全部 | — | — | — |

### 3.3 受理

依次检查：

1. **Agent**：工具名不冲突，schema 能编译，能力 id 不重复（`defineAgent` 时已查过，这里核对指纹）。
2. **任务**：history 里的工具调用成对；附件与模型能力匹配；预算不超过执行环境的上限；设了 `maxCost` 时，模型库里必须有该模型的价格。会话的一轮（§3.15）不能再给 history，接续点必须是同一会话里的一轮（`invalid_task`）；同一会话有运行中的轮时受理失败 `session_busy`（可重试）。
3. **模型**：按 §1.8 解析并核对要求。
4. **准入**：先受执行环境的并发运行上限约束，再按引擎的全局准入排队（§5.3）。

不通过时以 `failed` 结束，code 为 `invalid_agent`、`invalid_task`、`model_unsuitable` 或 `admission_timeout`。

### 3.4 准备

1. **准备能力**：逐个准备 Agent 的能力和交付物需要的能力。每项能力返回工具、能力说明、守卫和快照（§4.2）。
2. **按委托人过滤**：委托人联系不上时，排除需要委托人回应的工具（`ask_user`、`propose`）。
3. **冻结快照**：工具名、schema 哈希、各能力的快照指纹写入 `run_started`。运行中能力不再变化（I14）。
4. **处理不可用的能力**：准备失败或超时的能力（MCP 服务器连不上、熔断打开）不进入本次运行。不可用记录写入 `run_started`，并在视图尾部告诉模型。
5. **动态须知**：执行 `NoticeProvider`，产出以 `origin=hook` 追加到运行记录，调用经 `ctx.record` 留痕。
6. **写下 `run_started`**：内容包括五类指纹（§6.4）、能力快照、实际模型、作业范围、委托人能否联系上。

### 3.5 ① 组装

| 项目 | 内容 |
|---|---|
| 做什么 | 检查取消和预算 → 追加上一步留下的提示和委托人引导 → 工具呈现给出本步可见的工具 → 记忆给出压缩决定，引擎按决定渲染 history 和运行记录（会话窗口仍超限时丢掉最早的整轮）→ 按固定布局拼成模型输入 → 复核工具子集、前缀哈希 → 检查是否达到输入上限（模型窗口减去输出预留） |
| 槽位 | 记忆：`recall(state)`；工具呈现：`visible(state)` |
| 事件 | `step_started`、`intervention_applied`、`context_built` |
| 去向 | → ②；超限 → 结束，`stopped` / `context_overflow` |

### 3.6 ② 推理

| 项目 | 内容 |
|---|---|
| 做什么 | 经模型库的并发上限和熔断调用一次模型，流式推送增量；SDK 不执行工具 |
| 事件 | `model_responded` / `model_failed` / `model_aborted` |
| 去向 | 有工具调用 → ③；没有 → ④；失败 → 结束，`failed` / `model_error` |

### 3.7 ③ 行动

| 项目 | 内容 |
|---|---|
| 做什么 | 每个调用走一遍工具流水线（§8.2）。调用之间并发执行，审批串行排队；委托在这里发起子运行；结果按调用顺序一次性追加 |
| 槽位 | 权限规则：`permit(call)`；审批：`approve(request)` |
| 事件 | `permission_decided`、`approval_answered`、`tool_finished` |
| 去向 | → ④ |

### 3.8 ④ 观察

核心只产生事实，不调用模型，可以从日志随时重算；"记账"由各守卫在自己的运行内实例里完成（详见 docs/guard-mechanism.md §3）。

| 事实 | 内容 |
|---|---|
| 文本与意图 | 本步文本；是否调用了意图工具，意图是什么 |
| 工具结果 | 工具名、所属能力、输入哈希、输出哈希、成败、错误码与错误类别（确定性 / 瞬时）、副作用类型、耗时、是否撞上封路、是否轮询类工具、是否意图工具 |
| 最终候选 | 本步没有工具调用且没有被截断，或只调用了表示完成的意图工具（包括 submit） |
| 新信息 | 本步是否有工具输出在本次运行中第一次出现 |
| 干预 | 本步生效的干预；撞上的封路（施加者与收尾 code） |
| 压力 | 上下文、步数、时间、token、费用的已用比例（时间按收尾预留之前的可用时长计，到 1 时以 `timeout` 收尾）；剩余步数。时间相关的事实按最近一条日志事件的时间计算，回放时可以重算 |

### 3.9 ⑤ 反思

守卫看本步事实、记自己的账、给出意见：告知（问题、建议、可选的封路）、等待输入、或终止（收尾 / 停止）。守卫互相独立，并行执行，结果按来源顺序收集：任务 → 执行环境 → 能力 → 引擎 → 核心内置的预算守卫（`guard:pressure`）。引擎在合并前执行三条规则：

- **先告知后终止**：同一来源在运行中（或最近一次引导之后）没有告知过就要求终止时，本步改为告知并记 `deferred`，下一步再终止。"告知过"以告知真正进了纠偏消息为准：被字数上限挤掉、或那一步裁决不是继续的告知都不算。
- **引导后重来**：委托人引导生效的步，所有守卫重新开始，封路全部解除。
- **出错降级**：守卫超时或抛错视为没有意见并记入日志；声明 `onError: 'stop'` 的守卫出错时停止，code `guard_error:<id>`。
- **联系不上不等输入**：委托人联系不上时，守卫的"等待输入"改为收尾（code 不变），同样先告知。

影子模式的守卫意见写入日志，不参与裁决。守卫清单与阈值见 §10.1。

### 3.10 ⑥ 判定

所有"下一步怎么办"都在这里决定，没有第二个决策点。④ 观察、⑤ 反思、⑥ 判定在实现上合成一个效果，写一条 `evaluated` 事件。

**意见来源，按顺序收集**

| 顺序 | 来源 | 怎么生效 |
|---|---|---|
| 1 | 封路违规 `guard:violation` | 本步再次调用了被封住的调用：收尾，code 取封路的 code |
| 2 | 待审批 `guard:approval` | 本步有调用的审批稍后答复（§9.10）：等待输入，code `approval_pending` |
| 3 | 意图（模型通过意图工具明确表达） | 参与合并 |
| 4 | 最终候选 `candidate` | 完成 |
| 5 | 守卫：任务 → 执行环境 → 能力 → 引擎 → 预算守卫 | 参与合并 |
| 6 | 默认值 | 前面都没有意见时：继续 |

**合并**：按"停止 > 等待输入 > 完成 > 收尾 > 继续"取最高的一条。完成排在收尾之前：守卫不能给出完成，也不能阻止完成，完成只由交付验收判定。

**引导优先**：有已收到、还没生效的委托人引导时（例如在生成最终回答期间到达），完成、收尾、等待输入以及意图工具的停止都改为继续，下一步带着引导重来；引擎和守卫的停止不让，之后的预算检查照常（§10.5）。

- 同级的结束类意见，取来源顺序靠前的那条。
- 同级的"继续"合并干预：发现按来源顺序拼接、去重，单条不超过 400 字、总长不超过 1200 字；封路取并集。
- 裁决为继续且有发现时，核心把发现渲染成一条纠偏消息（来源 `steering`）：目标、发现、已封住的调用、剩余预算、复盘要求与出口，整条不超过 2000 字。

**核心内置检查**

| 时机 | 条件 | 意见 |
|---|---|---|
| 合并前 | `finishReason=content-filter` | 停止，`content_filter` |
| 合并后 | 裁决为继续，但步数已用完 | 收尾，`max_steps`（结构化交付时停止） |
| 合并后 | 裁决为继续，但 token 或费用已用完 | 停止，`budget` |
| 合并后 | 结构化交付下裁决为收尾 | 改为停止，code 不变（兜底交付只能产出文本） |

**裁决生效**

| 裁决 | 执行 |
|---|---|
| 继续 | 下一步的 ① 追加纠偏消息，③ 执行封路 |
| 完成 | 进入交付的正常路径 |
| 收尾 | 进入交付的兜底路径 |
| 等待输入 | 结束，`awaiting_input` |
| 停止 | 结束，`stopped` |

裁决不是"继续"时，同一步收集到的干预不执行，但仍写入 `evaluated`。

### 3.11 交付

只在判定为"完成"或"收尾"时进入。生效的交付物是任务的交付物；任务没给时，用 Agent 的默认交付物；交付物没写验收时用引擎默认的验收（`createEngine` 默认带完成审查）。执行环境的强制验收总是叠加在后面；同一 id 的验收只跑一次，以执行环境的为准。

**正常路径**

| 顺序 | 做什么 | 不通过时 |
|---|---|---|
| 1 | 校验输出：文本交付要求非空；结构化交付要求 submit 已通过 schema 和领域校验 | 第一次：带提示回到下一步（结构化交付计一次自修）；再次：转兜底路径。结构化交付超过自修上限时，`failed` / `output_invalid` |
| 2 | 拦截类验收（`gate`）：先交付物的，后执行环境的，按顺序执行 | 带提示回到下一步，并计次；某项次数用完后放行，问题记入 `quality` |
| 3 | 定稿：`delivery_checked` 写入日志之后发出 `delivered` 通知（写不进去就不发，避免先看到"已交付"又看到失败） | — |
| 4 | 标注类验收（`annotate`）：结果记入 `quality`，不改变结果 | — |

→ 结束，`completed`。

- **退回前先看预算**（与 ⑥ 合并后的检查一致）：没有下一步可用时不再退回——步数用完或只剩收尾预留时，文本交付转兜底路径（code `max_steps` / `timeout`），结构化交付停止；token 或费用用完时停止（`budget`）。
- **取消**：交付中途取消时，剩下的验收和兜底都不再执行，也不发出 `delivered`，运行以 `aborted` 结束；因取消而出错的验收不算通过。
- **截止时间到**：不算取消，照样交付；被截止时间中断（或之后才开始）的验收不算通过，记为未解决（`截止时间到，验收没有完成`）进入 `quality`，不再退回。

**兜底路径**

| 顺序 | 做什么 |
|---|---|
| 1 | 生成阶段性交付：本步视图（接上本步的回复和工具结果）+ 兜底说明（以本次任务目标开头，要求只针对本次任务作答，之前对话只作背景）+ 已执行的副作用清单，禁用工具调用一次模型，三级退化（§8.4）；每一级先估算上下文，超出窗口直接进入下一级（I7）；被截断或被内容过滤的回复不算，退到下一级 |
| 2 | 经过输出契约的 `sanitize` |
| 3 | 定稿：发出 `delivered` 通知 |
| 4 | 标注类验收 |

→ 结束，`finalized`。

兜底说明来自交付物的 `fallback`，按收尾的 code 选择，再按委托人能否联系上选择版本：
- 联系得上：说明进展和卡点，最后提一个能让工作继续的具体问题；
- 联系不上：报告进展和卡点。

### 3.12 结束与结局

结束环节依次做三件事：汇总结果 → 不变量自检（§6.3）→ 写 `run_ended`，释放能力（例如归还 MCP 连接租约）。

**进程中断的运行**：引擎启动时，为运行档案里没有 `run_ended` 的运行补齐结尾：已发出但没有结果的工具调用补上 `TOOL_INTERRUPTED`，保证成对；再补记 `run_ended`（`aborted` / `interrupted`），通过 `engine.interrupted()` 交给应用。判断哪些调用没有结果时只看最后一次模型回复之后的结果（提供方可能跨步复用调用 id）。补齐假定档案只由本进程使用：多个进程共用一个档案时，需要由应用保证同一时刻只有一个进程在补齐。

**没开始就结束的运行**（受理失败、排队超时、须知拦下、引擎已关闭）只有 `run_ended`：它带上 `origin`（根运行、父运行、执行环境、Agent、指纹、主题），档案据此生成运行摘要，可以按状态和主题查到，也会按保留期清理。

**接着做**：引擎不提供续跑。多轮对话和接着做中断或已结束的工作，都用会话开启新的一轮（§3.15）：前文由引擎从会话日志推导，中断的轮带着一行结局说明，可能已执行的副作用在台账里。不带会话时，应用仍可以把上次运行的运行记录（`Transcript` 投影）作为新任务的 history，并追加 `retrospect.brief`。运行中的引导用 `steer`；运行结束后 `steer` 返回 `false`。

| 结局 | 含义 | 典型 code |
|---|---|---|
| `completed` | 交付了结果 | —；以意图工具完成时为该意图的 code，如 `finish` |
| `awaiting_input` | 需要委托人回复才能继续 | `ask_user`、`propose`、`approval_pending`、守卫给出的 code |
| `finalized` | 没完成，给出了阶段性交付 | `repeat`、`failure_streak`、`stall`、`no_progress`、`max_steps`、`timeout`、`empty_output`、`user_denied`、`spawn_failed`、`external_failure`、`truncated` |
| `stopped` | 没完成，直接停止 | `blocked`、`stale_dossier`、`content_filter`、`context_overflow`、`budget`、`timeout`、`guard_error:<id>` |
| `failed` | 出错 | `model_error`、`model_unsuitable`、`output_invalid`、`invalid_agent`、`invalid_task`、`admission_timeout`、`engine_error` |
| `aborted` | 被取消或进程中断 | `user`、`parent`、`interrupted` |

### 3.13 运行记录与视图布局

**运行记录只追加**，每条都标明来源：

| 来源 `origin` | 角色 | 追加时机 |
|---|---|---|
| `model` | assistant | ② 之后 |
| `tool` | tool | ③ 之后，按调用顺序一次性追加 |
| `hint` | system，带来源标签 | 下一步 ① 开始时，紧跟在上一步的工具结果之后 |
| `steer` | user | 同上 |
| `hook` | system | 准备环节（动态须知） |

- 只追加、不插入，不会拆开工具调用和结果的成对关系（I2），也不会改写已有前缀（I3）。
- 提示一旦生效就永久保留。
- `Transcript` 投影保留每条的 `origin`：会话的下一轮只带模型回复、工具调用与结果、委托人引导和交付退回的提示（§3.15）。

**视图布局固定**，由核心按稳定程度排列，不开放：

```
[须知][Agent 指令][能力说明][history][任务输入][运行记录][易变信息与不可用提示]
└──────────────────────── 稳定前缀，可以命中缓存 ───────────────────┘└──── 尾部 ────┘
```

- 须知对同一执行环境里的所有 Agent 都相同，可以在不同 Agent 之间共享缓存。
- 记忆只压缩 history 和运行记录，不碰任务输入。记忆只给出决定（前 `upTo` 条换成摘要），视图由引擎渲染（`renderView`）；压缩只改变视图，并且每一步都写进日志。

### 3.14 并发、取消与限额

**并发**

- 同一次运行里，步与步严格串行。
- 一步之内的工具调用并发执行，上限为执行环境的 `caps.toolConcurrency`（默认 5）；声明了 `exclusive` 的工具串行执行。
- 审批请求串行排队。
- 反思参与者并行执行。

**取消树**

- 每个运行有自己的取消源，子运行挂在父运行之下，取消信号沿树向下传播。
- 取消时，已经流式输出的部分文本记入 `model_aborted.partialText`。
- 已发出但还没执行的工具调用，补上 `TOOL_ABORTED` 结果，保证成对。
- 取消后不再交付，结局为 `aborted`。

**限额归属**

| 限额 | 归谁 | 默认值 | 用完时 |
|---|---|---|---|
| 步数、总时长、收尾预留、token、费用 | 任务的预算，不超过执行环境的上限 | 1000 步；时长不限（子运行不超过父运行剩余的时长，两边都没设时 10 分钟）；收尾预留 min(120 秒, 总时长的 20%)，给出的预留不小于总时长时同样收紧 | 守卫：收尾或停止 |

**收尾预留的保护**：模型调用最晚在"截止时刻 − 收尾预留"被截断（`model_aborted` 带 `deadline: true`，不算取消），这一步按没有完成的回复评估，随后按 `timeout` 走兜底。兜底不超过离截止实际剩下的时间；截止在兜底中途到达时仍交出固定文本，以 `finalized` / `timeout` 结束。时间到停止（没有收尾预留时）的运行不把最后一步的文本当作交付。
| 并发运行数 | 执行环境的上限 | 不限（仍受全局准入约束） | 受理排队 |
| 工具并发、委托深度与次数、子运行并发、审批等待、等待子运行交付 | 执行环境的上限 | 5；深度 3、每个子 agent 3 次、并发 10；审批 5 分钟；等待子运行 10 秒 | 排队；`SPAWN_*` 信封；审批按拒绝处理；子运行记为 `aborted` |
| 提供方并发；模型首 token / 空闲 / 单次时长 | 模型库 | 4；120 秒 / 120 秒 / 10 分钟 | 排队；`MODEL_TIMEOUT` |
| MCP 连接等待 | 能力宿主 | 3 秒 | 该能力不进入本次运行 |
| 全局并发运行数、排队等待 | 准入 | 20；5 分钟 | `failed` / `admission_timeout` |
| 工具执行时长 | 工具 | 30 秒 | `TOOL_TIMEOUT` |
| 组件单次调用 | 组件 | 30 秒；记忆 120 秒；hook 10 秒 | 按组件类型降级（§4.4）；组件经 `ctx.callModel` 发起的调用没写超时时比组件的时限早 1 秒结束，结束时就记进日志 |
| 结构化交付的自修次数 | 输出契约 | 3 次 | `failed` / `output_invalid` |
| 拦截次数 | 每项验收 | 1 次 | 放行，问题记入 `quality` |

预算的计入范围：主模型调用、记忆和监督的模型调用、工具经 `ctx.callModel` 的模型调用、子运行。所有时间都取自时钟。

---

### 3.15 会话

多轮对话是一串按接续关系连起来的运行（完整方案见 [session-design.md](session-design.md)）。会话的产品层（id、权限、列表、界面）归应用，上下文层归引擎：

```ts
environment.start(agent, task, { session: 'case-1024' })                    // 接着最新的一轮
environment.start(agent, task, { session: 'case-1024', continues: runId })  // 从指定的一轮分叉
environment.start(agent, task, { session: 'case-1024', continues: null })   // 从头开始
engine.previewWindow({ session: 'case-1024' })                              // 下一轮会带入的窗口；有一轮正在运行时 session_busy
engine.deleteSession('case-1024')                                           // 整个会话一起删除
```

| 方面 | 做法 |
|---|---|
| 会话日志与窗口 | 会话日志是各轮的运行日志，只追加；窗口是某一轮开始时带入的前文，由 carry 从接续点的窗口与日志确定性地推导，冻结进 `run_started`（I17） |
| carry | 套上接续点最后一次已提交的压缩；按视图顺序拼起前文、任务输入、运行记录；只带模型回复、工具调用与结果、委托人引导和交付退回的提示；补齐成对；补上结局（兜底文字、没有正常结束时一行说明）和最后一次组装之后才到的引导 |
| 窗口大小 | 每轮按本轮模型计算：可用空间 = 窗口 − 输出预留 − 固定占用；轮开始线 50%、轮中触发线 80%、保留线 10%、摘要上限 10%（§11 `compactingMemory`） |
| 超限裁剪 | 压缩之后仍达到输入上限时，引擎确定性地丢掉前文里最早的整轮，摘要后加一行说明；不调用模型 |
| 副作用台账 | 本会话已执行和可能已执行的副作用，含子运行的；沿序号递推（分支之间共享），最多 50 条，放在尾部，不交给摘要模型（I15 跨轮） |
| 串行与分叉 | 同一会话一次一轮（包括不同分支），第二轮 `session_busy`；一个档案只由一个引擎实例写；分叉就是 `continues` 指向的不是最新一轮 |
| 子运行 | 只有根运行是轮；子运行按 `rootRunId` 归到它的轮 |
| 保留与删除 | 会话按整体过期与删除，不会只剩半条链 |

## 4. 扩展架构

### 4.1 组件目录

所有开放的组件都在下表。每类组件只有一个方法，用它所在环节的动词命名。

| 组件 | 所属业务对象 | 环节 | 方法 | 数量 | 谁来提供 |
|---|---|---|---|---|---|
| 能力 `Capability` | Agent | 准备 | `prepare(ctx)` | 多个 | 业务开发者；终端用户以数据选用 |
| 工具呈现 `Exposure` | Agent 的工具箱 | ① 组装 | `visible(state)` | 1 | 标准实现；可替换 |
| 输出契约 `OutputContract` | 交付物 | 交付 | `validate(candidate, ctx)` | 1 | 业务开发者 |
| 验收 `Check` | 交付物；执行环境的强制验收 | 交付 | `accept(candidate, corpus)` | 多个 | 业务开发者；平台 |
| 守卫 `Guard` | 任务；执行环境；能力；引擎 | ④ 观察 + ⑤ 反思 | `start(run, ctx).check(facts)` | 多个 | 业务开发者；平台 |
| 权限规则 `PermissionRule` | 执行环境 | ③ 行动 | `permit(call)` | 多个 | 平台 |
| 审批 `Approver` | 执行环境的委托人 | ③ 行动 | `approve(request, run)` | 0–1 | 应用 |
| 须知生成 `NoticeProvider` | 执行环境的须知 | 准备 | `provide(run)` | 多个 | 平台；hook 适配 |
| 记忆 `Memory` | 引擎 | ① 组装 | `recall(state)` | 1 | 平台 |

**平台服务的端口**：`ModelProvider`（模型厂商适配）、`ArchiveStore`（运行档案的存储）、`Vault`、`Clock`、`Logger`、`CapabilityHost`（新的能力种类）。

### 4.2 能力

```ts
interface Capability {
  id: string; version: string
  kind: string                            // 'tool' | 'mcp' | 'skill' | 'subagent' | 'planning' | 'intents' | 'bundle' | 自定义
  prepare(ctx: PrepareCtx): Promise<Prepared>   // 运行开始时执行一次，结果冻结
}
interface PrepareCtx {
  run: RunInfo; signal: AbortSignal; deadline: number
  host<T>(kind: string): T                // 取得对应的能力宿主，例如 MCP 连接池
  vault: SecretResolver                   // 按引用解析凭据，解析结果不进日志
}
interface Prepared {
  tools: ToolDef[]
  description?: Segment[]                 // 能力说明，进入视图的稳定前缀
  guards?: Guard[]                        // 能力自带的守卫，来源 capability:<id>
  exposure?: 'eager' | 'deferred'         // 默认呈现方式，供工具呈现参考
  snapshot: { fingerprint: string; detail?: unknown }
  release?(): void                        // 运行结束时调用
}
```

**标准能力**

| 能力 | 构造 | 准备时做什么 | 提供什么 | 宿主 |
|---|---|---|---|---|
| 工具 | `tool(def)`、`tools(defs)` | 直接使用 | 工具 | — |
| MCP | `mcp(spec)` | 从连接池取连接，最多等待 `connectTimeoutMs`；列出工具；按工具列表生成快照 | 工具（默认延后呈现）；依赖不可用由失败连击与封路处理 | MCP 连接池 |
| Skill | `skill(pkg)` | 按内容哈希冻结 SKILL.md | 能力说明里的 skill 列表；共享的激活工具 | skill 宿主 |
| 子 agent | `subagent(agent, opts)` | 计算子 agent 指纹 | 共享的委托工具 | 委托调度 |
| 规划 | `planning(opts)` | 直接使用 | `update_plan` 工具、计划推进守卫 `progress`、使用说明 | — |
| 与委托人沟通 | `intents()` | 委托人联系不上时排除 `ask_user`、`propose` | 意图工具 `finish`、`ask_user`、`propose`、`report_blocked`，以及使用说明 | — |
| 能力包 | `bundle({ ... })` | 展开 | 工具、说明、守卫 | — |
| 自定义 | 实现 `Capability` | 自定义 | 自定义 | 可以注册新的宿主 |

- **同类合并**：多个 skill 共用一个激活工具，多个子 agent 共用一个委托工具。
- **工具名冲突**：在准备环节报错，运行以 `failed` / `invalid_agent` 结束。不同能力提供同 id 的守卫（来源都是 `capability:<id>`）同样报错；同一个守卫对象被多个能力共享时只算一个。MCP 工具按 `服务器名__工具名` 加前缀；完整名字不符合 `^[A-Za-z0-9_-]{1,64}$` 时改用规整名字（非法字符换成下划线、截到 55 个字符，再接下划线与原名哈希的前 8 位），调用时仍用服务器上的原名，快照记为 `renamed`；规整后在能力内重名的跳过（记为 `skipped`）。MCP 工具的 schema 编译不过时：draft-07 的 `definitions` 改写成 `$defs` 再试；还不行就去掉条件约束（`if`/`then`/`else`、`not`、`dependent*`）和找不到目标的引用，保留属性和类型（快照里记为 `relaxed`）；仍不行才跳过（记为 `skipped`）。
- **MCP 规格**：

  ```ts
  interface McpServerSpec {
    name: string
    transport:
      | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string | SecretRef>; cwd?: string }
      | { kind: 'http'; url: string; headers?: Record<string, string | SecretRef> }
    tools?: { include?: string[]; exclude?: string[] }
    exposure?: 'deferred' | 'eager'          // 默认 deferred
    connectTimeoutMs?: number                // 默认 3 秒
    callTimeoutMs?: number
    errorClass?: Record<string, 'deterministic' | 'transient'>   // 键为原始工具名，`*` 为缺省
  }
  ```

  MCP 工具的 annotations 映射为副作用类型：`readOnlyHint` → `none`，`idempotentHint` → `idempotent`，其余为 `side_effect`。工具返回的图片块（`image`，带 base64 的 `data` 与 `mimeType`）作为图片交给模型（§8.2 h 规整），音频等其他非文本块仍是一行占位；工具返回 `isError` 时记为 `TOOL_EXCEPTION`；协议不区分错误类别，缺省按瞬时处理（同样的输入允许再试一次）。应用可以用 `errorClass` 声明类别，声明为 `deterministic` 的失败第一次就被封路。
- **插件**：Claude Code 格式的插件由格式解析器拆开，用在哪、启用哪些由应用决定：

  | 插件内容 | 解析成 | 交给 |
  |---|---|---|
  | `skills/` | `skill(pkg)` | Agent 的能力 |
  | `agents/` | Agent 定义 | 独立 Agent，或 `subagent(...)` |
  | `.mcp.json` | `mcp(spec)`，环境变量写成 `SecretRef` | Agent 的能力 |
  | `hooks/hooks.json` | `HookSpec[]`，由 `adaptHooks` 翻译成须知、权限、守卫、强制验收 | 执行环境 |
  | `commands/` | 斜杠命令 | 应用：展开成任务输入 |

### 4.3 组件规约

所有组件都遵守：

| # | 规约 | 内容 |
|---|---|---|
| 1 | 身份 | 有 id 和版本，进入所属对象的指纹；行为一改就升版本 |
| 2 | 实例 | 每次运行一个实例（`start(run, ctx)`）；能力在每次运行开始时准备一次 |
| 3 | 只读输入 | 只能看到为它准备的只读输入 |
| 4 | I/O 留痕 | 只能经过 `ctx.callModel` 或 `ctx.record` 做 I/O，全部写入日志；重放时直接读日志 |
| 5 | 超时 | 每次调用都有超时 |
| 6 | 固定降级 | 出错时按组件类型走固定的降级（§4.4） |
| 7 | 影子模式 | 支持 `mode: 'shadow'`：照常运行和记录，但不生效 |
| 8 | 只收窄 | 不能放大权限和能力（I4） |
| 9 | 一致性测试 | 每类组件都有一致性测试集：确定性、只收窄、不破坏成对和前缀、边界输入不抛错 |

重复的组件 id、重复的工具名、单例槽位重复配置，在 `createEngine`、`engine.environment()`、`defineAgent()`、`defineTask()` 时就报错。

### 4.4 组件边界

| 组件 | 能看到 | 能做 | 不能做 | 出错时 |
|---|---|---|---|---|
| 能力（准备） | 宿主、凭据解析、截止时间 | 产出工具、说明、守卫、快照 | 读运行记录；改其他能力 | 不进入本次运行，记入 `run_started` |
| 工具 | 自己的输入；`ToolCtx` | 执行业务动作；发起子运行 | 读运行记录；写日志；绕过权限 | 包成错误信封回给模型 |
| 工具呈现 | 已准备的工具、运行记录里的工具调用 | 决定本步可见哪些工具 | 加入不存在的工具 | 退回为"全部可见" |
| 记忆 | history、运行记录、模型窗口与输入上限、估算器；会话的一轮另有带入的摘要与轮起点 | 返回压缩决定（前 `upTo` 条换成摘要）与尾部提示 | 改写传入的消息；动任务输入；切点拆开成对 | 出错、超时、返回值不合格、切点拆开成对或超出范围：沿用上一步生效的压缩（第 1 步为不压缩），超出输入上限时按超限停止 |
| 守卫 | 本步事实、运行信息、自己的运行内状态 | 告知（可带封路）、等待输入、终止 | 给出完成；执行动作；改视图 | 本步没有意见，记入日志；`onError: 'stop'` 时停止 |
| 输出契约 | 候选交付 | 判断格式是否合格 | 改写交付内容 | 视为不合格 |
| 验收 | 候选交付、语料 | 通过，或给出问题和提示 | 改写交付内容 | 视为通过，记入日志 |
| 权限规则 | 工具调用、运行信息 | 放行、拒绝、询问 | 推翻其他规则的拒绝 | 按拒绝处理 |
| 审批 | 审批请求 | 同意或拒绝，可选记住 | — | 按拒绝处理 |
| 须知生成 | 运行信息 | 产出须知 | — | 跳过，记入日志 |
| 平台服务的端口 | 端口参数 | 对外 I/O | 影响裁决 | 模型 → `failed` / `model_error`；存储 → `failed` / `engine_error` |
| 订阅者 | 事件、通知（带所属运行的 `runId`） | 投影到界面、业务库 | 改变运行 | 写诊断日志（warn），运行继续；事件异步交给订阅者，处理慢不拖住运行，运行结束时最多等 5 秒 |

### 4.5 定制方式

| 方式 | 含义 | 例子 |
|---|---|---|
| 配置 | 调整组件参数 | 调守卫阈值、改兜底说明、改压缩触发比例 |
| 组合 | 选用哪些组件 | Agent 选能力；交付物选验收；执行环境选权限规则 |
| 新增 | 往数量为"多个"的槽位加实例 | 新能力、守卫、强制验收、权限规则、能力宿主 |
| 替换 | 自己实现组件 | 自定义压缩、引擎守卫、审批、存储 |
| 装饰 | 包一层已有实现 | 模型降级、工具缓存与限频 |

### 4.6 对修改关闭的部分

以下部分不开放；改动意味着引擎升主版本：

| 部分 | 原因 |
|---|---|
| 流程的环节与顺序 | 所有组件都依赖它 |
| 视图布局 | 前缀稳定（I3）和缓存依赖它 |
| 判定的来源顺序与合并规则 | 只能有一个决策点，裁决才能解释和重放 |
| 工具流水线和交付环节的顺序 | 安全、成对、交付质量依赖它 |
| 意见、裁决、干预（纠偏消息、封路）的类型 | 干预由引擎执行，涉及成对、前缀、缓存 |
| 结局类型 | 新的原因用 code 表达 |
| 不变量（§7） | 稳定性的底线 |
| 运行日志格式 | 演进靠 `schemaVersion` 和升级器 |

**已认可的变更**

| 变更 | 原因 | 认可 |
|---|---|---|
| 判定的来源顺序加入待审批 `guard:approval`，排在封路违规之后、意图之前（§3.10）；合并规则不变 | 审批稍后答复时这一轮必须停下等委托人；它给出的是等待输入，排在意图之前，模型同时请求输入时结局的 code 取 `approval_pending`，守卫的停止仍然优先 | 2026-11-04 |

**契约的版本策略**

| 契约 | 策略 |
|---|---|
| 业务对象（`AgentDef`、`TaskDef`、`Deliverable`、`EnvironmentConfig`、`EngineConfig`）、`Run`、`RunResult`、`ToolDef` | 语义化版本；新增字段必须可选 |
| 组件接口、`Opinion`、`Intervention`、`Observation`、`Candidate` | 字段只增不改；破坏性变更升主版本 |
| `RunEvent` | `schemaVersion` + 升级器；应用优先使用投影 API |
| 平台服务的端口 | 语义化版本 |

### 4.7 业务 Agent 适配

适配一个业务 Agent 只涉及五样东西：**指令、能力、交付物、业务守卫、业务上下文**。它们都是数据，或者只有一个方法的组件，不需要改引擎。多次运行之间的编排（例如多个岗位依次或并行运行）、调度与优先级属于应用，由应用用多次 `start` 组合实现。

| 步骤 | 做什么 | 用什么 | 必需 |
|---|---|---|---|
| 1 | 写角色指令 | `instructions` | 是 |
| 2 | 把业务能力接进来 | 业务 API → `tools()`；已有服务 → `mcp()`；业务知识 → `skill()`；多角色协作 → `subagent()`；要和委托人沟通 → `intents()` | 是 |
| 3 | 定交付物 | 输出格式：`text()` 或 `structured(schema, { validate })`；业务质量标准：`Check` | 否，默认文本交付 |
| 4 | 定工单约束 | 业务上必须停止或等人的条件：任务的 `guards`（`Guard`）；任务目标 `goal` | 否 |
| 4' | 传业务参数 | 档案 id、判断时点等放进任务的 `context`；工具通过 `ctx.task.context` 读取，组件通过 `RunInfo.task.context` 读取 | 否 |
| 5 | 选执行环境 | 交互或后台；需要时为业务新建一个执行环境（权限、强制验收） | 是 |
| 可选 | 业务特有的"卡住"判据 | 随能力提供 `Guard`，可以用 `thresholdGuard` 写计数类守卫 | 否 |
| 可选 | 工具缓存、限频、计费 | 装饰 `ToolDef` | 否 |

**最小的业务 Agent**

```ts
const helper = defineAgent({
  id: 'helper',
  instructions: [rolePrompt],
  capabilities: [tools(helperTools), intents()],
})
interactive.start(helper, defineTask({ input }))
```

**一个完整的业务 Agent**

```ts
const analyst = defineAgent({
  id: 'analyst',
  instructions: [rolePrompt],
  capabilities: [mcp(marketData), tools(readOnlyTools), skill(valuationGuide)],
  deliverable: { output: structured(ThesisSchema, { validate: validateThesis }),
                 checks: [evidenceRequired({ mode: 'gate' })] },
  model: { requires: { minContext: 128_000 } },
})

background.start(analyst, defineTask({
  input: [researchBrief],
  context: { dossierId, asOf },            // 数据工具按判断时点取数
  guards: [dossierUnchanged()],            // 从 RunInfo.task.context 读取档案 id
  budget: { maxSteps: 60, maxCost: 2 },
  subject: dossierId,
}), { model: analystModel })
```

**终端用户的 Agent** 是纯数据：应用把定义数据里的指令和能力引用解析成 `defineAgent(...)`，其余部分使用默认值。不需要维护版本号，引擎按内容计算指纹。

---

## 5. 稳定性设计

### 5.1 机制总览

| 风险 | 机制 |
|---|---|
| 不收敛、死循环 | 预算；守卫先告知后终止；封路；撞上封路直接收尾；兜底交付三级退化 |
| 外部依赖故障 | 建连阶段重试；熔断跟着依赖走、所有运行共享；错误信封；同级模型降级 |
| 资源耗尽 | 准入、模型库、执行环境分级限制并发；子运行继承父运行的预算 |
| 副作用被重复执行 | 工具声明副作用类型；每次调用带幂等键；有副作用的调用永不自动重做 |
| 组件故障 | 超时；固定降级；hook 和 stdio MCP 在独立进程里运行；新组件先在影子模式下验证 |
| 进程中断 | 先写日志再改状态；启动时补齐中断运行的结尾并交给应用；应用以上次的运行记录开启新运行接着做；有副作用的调用不会被重做 |
| 状态损坏 | 运行记录只追加；每步复核成对和前缀；结束时不变量自检 |
| 交付质量不可控 | 交付环节集中做输出校验、验收、兜底；验收分拦截、标注、影子三种模式 |
| 成本、缓存失控 | 视图布局固定；能力快照；顾问调用次数上限 |
| 安全 | 权限只能收窄；沙箱；审批；凭据只按引用解析，不进业务对象和日志 |

### 5.2 熔断

| 依赖 | 所在服务 | 键 | 打开后 |
|---|---|---|---|
| 模型 | 模型库 | 提供方 + 模型 | 推理快速失败，`MODEL_UNAVAILABLE`；配了降级装饰时走降级，否则 `failed` / `model_error` |
| MCP 服务器 | MCP 连接池 | 服务器规格的指纹 | 准备环节：该能力不进入本次运行；运行中：调用直接返回 `TOOL_UNAVAILABLE` |
| 单个工具（可选） | 能力宿主 | 能力 id + 工具名 | 调用直接返回 `TOOL_UNAVAILABLE` |

- 状态迁移：关闭 → 打开 → 半开。默认连续失败 5 次就打开；冷却 30 秒后半开，放行 1 次探测；成功就关闭，失败就重新打开。
- 只统计依赖本身的故障：超时、连接错误（包括没有状态码的连接失败）、5xx。参数错误、业务错误不计入；MCP 服务器返回的 JSON-RPC 错误和客户端的输出校验错误也不计入。
- 只有探测调用能释放半开状态的探测名额；熔断打开之前放行的调用迟到的失败，不会重新打开熔断。
- 状态变化通过 `engine.onHealth` 通知应用。
- 熔断返回的 `TOOL_UNAVAILABLE` 由失败连击守卫（占多数时 code `external_failure`）与封路处理，纠偏消息提示不要用相同输入重试、改用其他工具或基于已有信息作答。

### 5.3 准入与并发

| 限制 | 归谁 | 默认值 | 超出时 |
|---|---|---|---|
| 全局并发运行数 | 准入 | 20 | 受理排队；超过 5 分钟 → `failed` / `admission_timeout` |
| 每个执行环境的并发运行数 | 执行环境的上限 | 不限 | 受理排队；防止一个执行环境占满全局名额 |
| 同一提供方的并发调用 | 模型库 | 4 | 推理排队 |
| 每次运行的工具并发 | 执行环境的上限 | 5 | 行动排队 |
| 子运行并发（按根运行、按委托深度分层统计） | 执行环境的上限 | 每层 10 | 排队；父运行等子运行时不占子运行那一层的名额，嵌套委托不会互相等死 |
| 同一个子 agent 的委托次数（按根运行统计） | 执行环境的上限 | 3 | `SPAWN_LIMIT` |

排队时间计入运行的总时长，并记入 `run_started.queuedMs`；时间压力、剩余时间和硬截止都从受理时刻算起。子运行等待名额的时间同样计入它自己的排队时间。业务上的优先级和日配额（例如后台事件分析每天最多处理多少条）由应用的任务队列决定，不在引擎里。

### 5.4 副作用与幂等

| 副作用类型 `execution.effect` | 含义 | 失败后自动重试 | 进程中断时没有结果 |
|---|---|---|---|
| `none` | 只读 | 允许（由工具决定） | 补 `TOOL_INTERRUPTED` |
| `idempotent` | 改变外部状态，重复执行结果相同 | 允许 | 补 `TOOL_INTERRUPTED` |
| `side_effect`（默认） | 改变外部状态，重复执行有害 | 不允许 | 补 `TOOL_INTERRUPTED`；复盘说明里标为"可能已执行"，接着做时提醒模型先核实 |

**结果未知的副作用**：有副作用的调用超时、执行中抛错或被取消、执行成功但结果没存下来（`TOOL_RESULT_LOST`）时，`tool_finished` 记 `possiblyExecuted: true`；错误提示加上"结果未知，可能已经执行：先核实是否已经生效，不要用相同输入重试"；封路对相同输入第 1 次就封住；副作用清单里记为"可能已执行"。

- `ToolCtx.idempotencyKey` = runId + callId，重试时不变。有副作用的工具应把它传给外部系统去重。
- **已执行的副作用清单**由 `effect` 不为 `none` 且执行成功的调用组成（进程中断时没有结果的有副作用调用单独列为"可能已执行"），用于兜底交付、复盘与重跑、完成审查。

### 5.5 隔离与影子模式

| 组件 | 隔离方式 |
|---|---|
| hook | 独立进程，带超时；只通过 hook 协议的标准输入输出交互 |
| stdio MCP 服务器 | 独立进程，由连接池管理；崩溃后由熔断接管 |
| 进程内组件 | 每次调用带超时；出错按 §4.4 降级 |
| 工具 | 超时即中止；异常包成信封 |

| 组件 | 影子模式下 |
|---|---|
| 守卫 | 意见写入日志，不参与合并 |
| 验收 | 结果写入日志，不拦截也不标注 |
| 权限规则 | 只记录"本来会拒绝或询问"，不生效 |

观察可以从日志重算，所以也可以拿旧日志离线回放来验证新组件。确定性检查必须先在影子模式下证明准确，才能改为拦截。

---

## 6. 实现机制

### 6.1 核心与执行器

```ts
// core/：纯函数。不读时钟、不取随机数、不做 I/O
function initial(snapshot: RunSnapshot): RunState
function apply(state: RunState, e: RunEvent): RunState
function nextStage(state: RunState): Stage | null   // admit | prepare | compose | reason | act | evaluate | deliver | end
function layout(parts: ViewParts): ModelInput       // 固定的视图布局
function stepFacts(state: RunState, opts): StepFacts      // ④ 的事实；evaluated.observation 就是它
function decide(obs: Observation, opinions: SourcedOpinion[], budget: BudgetState): Verdict
function renderSteering(input: SteeringInput): string      // 纠偏消息

// executor/：驱动一次运行
for (let s = nextStage(state); s; s = nextStage(state)) {
  const events = await perform(s)            // 唯一产生副作用的地方：调用模型、执行工具、运行组件
  await archive.append(runId, events)        // 先写日志
  state = events.reduce(apply, state)        // 再更新状态
  await notify(subscribers, events)
}
```

- `evaluate` 是一个效果，包含 ④ 观察、⑤ 反思、⑥ 判定；其中只有反思会做 I/O。
- 核心出错，或结束时不变量自检没通过，运行以 `failed` / `engine_error` 结束，并保留完整日志。

### 6.2 运行日志

```ts
type RunEvent = { seq: number; at: number } & (
  | { t: 'run_started'; agent: AgentSnapshot; task: TaskSnapshot;
      environment: { name: string; fingerprint: string; principalReachable: boolean };
      engine: { fingerprint: string };
      capabilities: CapabilitySnapshot[]; unavailable: Array<{ capability: string; reason: string }>;
      model: ModelRef; modelFingerprint: string; contextLimit: number; outputReserve: number; queuedMs: number;
      parentRunId?: string; rootRunId: string; schemaVersion: number; session?: SessionStarted }
  | { t: 'step_started'; step: number }
  | { t: 'intervention_applied'; step: number; intervention: Intervention; source: string; until?: number }
  | { t: 'context_built'; step: number; messages: BlobRef[]; tools: string[]; estimate: number;
      compaction?: { upTo: number; summary: BlobRef; reason?: CompactionReason; tokens?: { before: number; after: number } } }
  | { t: 'model_responded'; step: number; response: ModelResponse; startedAt: number; firstTokenAt?: number }
  | { t: 'model_failed'; step: number; error: ModelError; partialText?: string; startedAt: number }
  | { t: 'model_aborted'; step: number; partialText: string }
  | { t: 'permission_decided'; callId: string; verdict: PermissionVerdict; source: string }
  | { t: 'approval_answered'; callId: string; approved: boolean; remember?: RememberScope; deferred?: true; waitedMs: number }
  | { t: 'tool_finished'; callId: string; capability: string; effect: ToolEffect;
      shown: BlobRef; raw?: BlobRef; isError: boolean; errorCode?: string;
      startedAt: number; durationMs: number; childRunId?: string; childRunIds?: string[]
      possiblyExecuted?: true; errorClass?: 'deterministic' | 'transient';
      images?: Array<{ blob: BlobRef; mediaType: string }> }   // 工具返回的图片（§8.2 h 规整）
  | { t: 'external_call'; source: string; kind: 'model' | 'hook' | 'record';
      request: BlobRef; response: BlobRef; usage?: NormalizedUsage; startedAt: number; durationMs: number }
  | { t: 'steer_received'; text: string }
  | { t: 'evaluated'; step: number; observation: Observation;
      opinions: Array<{ source: string; opinion?: Opinion; mode: 'active' | 'shadow'; durationMs: number }>;
      verdict: Verdict; decidedAt?: number }          // 判定时刻：剩余时长按它算，回归重放按它重算
  | { t: 'step_ended'; step: number }
  | { t: 'delivery_checked'; step: number; path: 'normal' | 'fallback'; attempt: number;
      output: { ok: boolean; issues?: string[] };
      checks: Array<{ source: string; mode: CheckMode; pass: boolean; issues?: string[] }>;
      outcome: 'delivered' | 'returned' | 'fallback' | 'failed' | 'stopped'; code?: string; hint?: string }
  | { t: 'fallback_generated'; code: string; text: string; degradation: 0 | 1 | 2 }
  | { t: 'run_ended'; result: RunResult; origin?: RunOrigin }   // 没有 run_started 的运行带上归属，摘要据此生成
)
// 瞬时通知只推送、不写日志：text_delta、reasoning_delta、tool_progress、delivered
```

**写入规则**

- **按消息存 blob**：`context_built` 只记录每条消息的 blob 引用，blob 按 sha256 去重。
- **工具结果存两份**：`shown` 是模型实际看到的内容；`raw` 是原始输出，超过 1MB 时截断，并记录原始大小。结果里的图片以 base64 文本另存 blob（`images`），不脱敏：按文本模式替换会改坏图片数据，图片里的文字也匹配不到；图片里需要遮挡的内容由工具在返回前处理。这是下一条脱敏规则的例外。
- **先脱敏再写入**：凭据引用解析出的值（8 位以上）、provider key 原值，以及 `sk-`、`Bearer` 等模式；先编码成 JSON 再脱敏的文本，也按凭据的 JSON 转义形式替换。blob 引用和 id、哈希、指纹字段不脱敏，避免破坏引用。
- **任务内容**：`run_started.task.content` 引用任务输入与 history 的 blob，回归重放据此重建交付验收的语料；会话的一轮里 history 就是冻结的窗口，元数据（序号、接续点、轮起点、摘要、台账）在 `run_started.session`。
- **格式版本**：`run_started.schemaVersion` 当前为 2（版本 2 起 `modelFingerprint` 与用量的 `tools` 分组成为必填）；读取版本 1 的日志时由升级器补上这两项。
- **模型配置指纹**：`run_started.modelFingerprint` 是端口声明的调用参数（`ModelPort.settings`）的哈希，必填；平台改了某个模型的厂商参数或推理档位，前后运行的指纹不同。
- **输出预留**：`run_started.outputReserve` 记下给输出留的 token（模型声明的输出上限，最多取窗口的一半），输入上限 = `contextLimit` − 它；两个字段都必填。
- **补齐缺失的结果**：工具结果没能写进日志（例如存储暂时失败）时，运行结束前补上 `TOOL_MISSING_RESULT`，保证调用都有结果；它和 `TOOL_ABORTED` 一样计入"可能已执行"的副作用。

### 6.3 投影

| 投影 | 用途 |
|---|---|
| RunState | 当前状态 |
| Transcript | 运行记录，每条带 `origin` |
| Observation[] | 每步的事实 |
| Deliveries | 每次交付尝试：输出校验、验收结果、去向 |
| NormalizedUsage | 用量：主模型、记忆、监督、工具、子运行分开 |
| Trace | 观测树：运行 → 步 → 模型调用 / 工具 / 外部调用 / 子运行；每个节点带开始时间和耗时（§6.6） |
| SideEffects | 已执行的副作用清单 |
| SupervisionStats | 守卫告知与终止、顺延、纠偏消息、告知有效、封路违规、顾问采纳、验收结果 |
| RunRetrospective | 运行复盘（§10.8） |
| Corpus | 语料：任务输入 + history + 工具输出中的 `shown` |
| RunSummary | 运行摘要 |

**结束时的自检**：检查 I2、I11、I13、I14、I15、I16，以及观测树是否完整。开发和测试环境下，自检失败即报错；生产环境下写诊断日志（error），不中断应用。

### 6.4 指纹

| 指纹 | 组成 | 用途 |
|---|---|---|
| Agent | id、指令哈希、每项能力的 id / 种类 / 版本 / 配置哈希、工具呈现、默认交付物、模型偏好与要求、采样参数（给了才计入） | 统计和回放按它区分 agent；`version` 只是业务标签，不参与 |
| 任务 | 输入与 history 的哈希、业务上下文、交付物、目标、守卫、预算、作业范围 | 追溯这次做的是什么 |
| 执行环境 | 名称、委托人能否联系上、须知哈希、权限规则、守卫、强制验收、上限 | 区分不同的规矩 |
| 引擎 | 记忆与引擎守卫的 id / 版本 / 配置哈希（守卫另含 `onError`）；引擎替 Agent 补上的默认交付物（输出契约、验收、兜底）与默认工具呈现 | 平台机制与默认组件升级前后可以区分 |
| 能力快照 | MCP 工具列表哈希、skill 内容哈希、子 agent 指纹 | 追溯这次到底用了什么 |
| 模型配置 | 端口声明的调用参数（`ModelPort.settings`）：AI SDK 适配器为厂商、推理档位、是否丢弃历史推理、`providerOptions`、顶层 `reasoning` 与 header 名（不含 header 值） | 平台改了模型参数，前后运行可以区分 |

五类指纹、模型配置指纹和实际模型都写入 `run_started`。统计和评测按"Agent 指纹 × 模型 × 执行环境 × 引擎指纹"汇总。

### 6.5 重放

| 方式 | 做法 | 用途 |
|---|---|---|
| 严格重放 | 所有环节的结果直接从日志读取 | 审计；排查问题 |
| 回归重放 | 模型、工具、外部调用的响应从日志读取；其余组件重新执行，把新的裁决和交付结果与日志逐条比较 | 改了引擎、组件、Agent、交付物或执行环境之后做回归 |

### 6.6 观测：运行日志、trace 与诊断日志

| 通道 | 记什么 | 来源 | 完整性 | 参与回放 | 去处 |
|---|---|---|---|---|---|
| 运行日志 | 业务事实：发生了什么、状态怎么变 | 执行器写入 | 必须完整、有序 | 是 | 运行档案 |
| Trace | 时序与调用关系：时间花在哪、谁调用了谁 | 运行日志的投影，不单独记录 | 与运行日志一致 | — | 应用界面；可以导出到外部追踪工具 |
| 诊断日志 | 引擎和组件的内部情况 | `Logger` 端口；组件经 `ctx.log` 写入 | 可以按级别过滤，可以丢 | 否 | 应用的日志系统 |

**Trace 的时间信息**来自运行日志的字段：

| 节点 | 开始 | 结束 / 耗时 | 其他 |
|---|---|---|---|
| 运行 | `run_started.at` | `run_ended.at` | 准入排队 `queuedMs` |
| 步 | `step_started.at` | `step_ended.at` | — |
| 模型调用 | `model_responded.startedAt` | 事件的 `at` | 首 token `firstTokenAt`；每次尝试的开始、耗时、错误（`attempts`） |
| 工具调用 | `tool_finished.startedAt` | `durationMs` | 审批等待 `approval_answered.waitedMs`；子运行 `childRunId` |
| 外部调用 | `external_call.startedAt` | `durationMs` | 来源与种类、用量 |
| 反思参与者 | — | `evaluated.opinions[].durationMs` | — |

**诊断日志**

- `Logger` 有 debug、info、warn、error 四级；写入前同样脱敏。
- 只记排查需要的内容：组件出错被降级、订阅者出错、自检失败、熔断状态变化、准入排队超时等。业务事实一律只写运行日志。
- 条目带 `runId` 和 `step`（有的话），可以和运行日志关联。

**导出到外部追踪工具**：标准组件库提供订阅者 `otelExporter(opts)` 和 `langfuseExporter(opts)`，把运行事件转换成 OpenTelemetry span 或 Langfuse observation。它们不在核心里；导出失败只写诊断日志。


---

## 7. 不变量

全部由引擎代码强制，任何组件都无法关闭。

| # | 不变量 | 保证方式 |
|---|---|---|
| I1 | 运行一定会结束 | 限额；每次运行最多走一次兜底交付；守卫的计数有终止阈值，撞上封路直接收尾；验收有次数上限；进程中断的运行在下次启动时补记结束 |
| I2 | 每个 tool_use 后面紧跟它的 tool_result，中间不插入任何内容 | 结果按顺序一次性追加；缺失的补 `TOOL_MISSING_RESULT`；取消时补 `TOOL_ABORTED`；提示只放在工具结果之后；每步复核 |
| I3 | 须知、Agent 指令、能力说明、history、任务输入和已有的运行记录不被改写 | 视图布局固定；运行记录只增不改；每步比对前缀哈希。唯一例外是压缩：只改变视图、不动任务输入，并且必须写入日志 |
| I4 | 组件只能收窄能力，不能放大 | 可见工具必须是已准备能力的子集；权限规则只能拒绝；干预只有纠偏消息和封路 |
| I5 | 工具层的任何失败都包成错误信封回给模型 | 流水线的每个环节都产出 `ToolErrorEnvelope` |
| I6 | 不合格的交付不会以 `completed` 结束 | 交付环节先校验输出；拦截类验收不通过时退回（次数用完后放行，问题写入 `quality`） |
| I7 | 上下文估算达到输入上限（模型窗口减去输出预留）时，不调用模型 | 在 ① 组装强制检查；主调用与兜底调用的 `maxOutputTokens` 取输出预留 |
| I8 | 每一次模型调用都写入日志并计入预算 | 组件只能通过 `ctx.callModel` 调用模型；工具经 `ctx.callModel` 的调用同样写日志、计入预算（工具是业务代码，引擎不能阻止它另用客户端） |
| I9 | 模型错误一定带上分类后的错误码 | 以 `failed` / `model_error` 结束，`error.code` 为分类码 |
| I10 | 相同的事件序列产生相同的状态和环节 | 核心是纯函数；组件只能从 `ctx` 取时间、随机数和做 I/O |
| I11 | 每个裁决和交付结果都能找到来源 | 来源写入 `evaluated`、`delivery_checked`、`permission_decided` |
| I12 | 子运行深度有上限、不形成环、预算不超过父运行剩余额度 | 发起子运行时检查 |
| I13 | 状态的每次变化都先写入日志 | 执行器固定"先追加日志，再应用到状态" |
| I14 | 运行中 Agent、任务、执行环境、记忆与守卫、能力快照、模型都不变 | 执行器只读取它们；`run_started` 记下指纹 |
| I15 | 有副作用的工具调用永不自动重做 | 失败重试按副作用类型处理；进程中断后不重做，在复盘说明里标为"可能已执行"；结果未知的调用第 1 次就封住相同输入 |
| I16 | 守卫终止前先告知 | 同一来源在运行中（或最近一次引导之后）没有告知过就要求终止时，评估把它改为告知并顺延一步；结束时自检 |
| I17 | 会话的每一轮带入的窗口都能从会话日志重新推导出来 | 窗口在受理时由 carry 确定性地推导、冻结进 `run_started`；同一 carry 版本下，它等于接续点的窗口与日志（读到记下的事件序号为止）推导的结果，台账等于来源那一轮的台账加它及其子运行的副作用；`testing` 的 `sessionLogIssues` 逐轮复核 |

---

## 8. 内置部件

### 8.1 模型库与适配器

```ts
function modelHub(opts: {
  providers: ModelProvider[]
  default?: ModelRef
  concurrency?: Record<string, number>        // 按提供方，默认 4
  breaker?: BreakerPolicy                     // 按模型（§5.2）
  pricing?: PriceTable                        // 由应用提供；没有价格的模型，费用记为未知
}): ModelHub

interface ModelProvider { id: string; resolve(ref: ModelRef): ModelPort | undefined }
interface ModelPort {
  ref: ModelRef
  capabilities: { contextLimit: number; maxOutputTokens: number; vision: boolean; toolCalls: boolean;
                  reasoning: 'none' | 'optional' | 'forced'; systemAfterUser: boolean; parallelToolCalls: boolean }
  readonly settings?: unknown                 // 每次调用都带上的配置（可序列化），只用于模型配置指纹（§6.4）；凭据不放进来
  call(input: ModelInput, opts: { signal: AbortSignal; onDelta: (d: Delta) => void }): Promise<ModelResponse>
}
// ModelInput 的 temperature、topP 来自 Agent 的采样参数（§2），只出现在主模型调用与兜底调用里
interface ModelResponse {
  text: string
  reasoning?: { text: string; providerData?: unknown }   // 保留签名，回放时原样带回
  toolCalls: Array<{ id: string; name: string; input: unknown }>
  finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'other'
  usage: NormalizedUsage
  warnings: string[]
  attempts: Array<{ startedAt: number; durationMs: number; error?: string }>   // 每次实际请求，含建连重试；ModelError 同样带此字段
}
```

- 每次调用先经过模型库的并发上限和熔断，再到适配器。
- `ModelPort` 可以装饰：降级、录制回放、响应缓存。降级装饰器在运行中途换模型时，必须同时满足：
  - 只用于可用性故障（429、5xx、超时、熔断打开）；
  - 目标模型的窗口和能力不低于原模型；
  - 丢弃不属于目标模型的推理签名。

**AI SDK 适配器**（全包唯一 import `ai` 和 `@ai-sdk/*` 的地方）

| 职责 | 做法 |
|---|---|
| 单步调用 | `streamText` + `stopWhen: stepCountIs(1)`；工具只传 schema、不传 execute |
| 输出上限 | 请求没写 `maxOutputTokens` 时，用应用为该模型声明的 `capabilities.maxOutputTokens`；没有声明就不发（避免默认值截断推理模型的思考） |
| 重试 | 建连阶段沿用 SDK `maxRetries`：默认 2 次，指数退避，起点 2 秒，遵守 60 秒以内的 retry-after，只对 408/409/429/5xx 重试。流中途失败且还没收到任何内容时，可重试的错误再试一次。每次尝试写入 `attempts` |
| 错误分类 | 剥开 `NoOutputGeneratedError` 后，归类为 `MODEL_TIMEOUT`、`MODEL_CONNECTION`、`RATE_LIMITED`（可重试，计入熔断）、`AUTH_FAILED`、`CONTEXT_TOO_LONG`（按 `context_overflow` 处理）、`CONTENT_FILTER`、`MODEL_ERROR` |
| reasoning 参数 | Anthropic：thinking 预算 2048 / 4096 / 8192；OpenAI：`reasoningEffort`，并开启 `parallelToolCalls`；Google：`thinkingConfig`，关闭时为 0；Ollama：`think`。强制开启 thinking 的模型，只有用户选择关闭时才注入关闭参数。SDK 会过滤的厂商私有参数在 fetch 层注入 |
| 采样参数 | `ModelInput` 带 `temperature`、`topP` 时原样传给 `streamText`，不带时不发 |
| 端口参数 | `settings` 为厂商、推理档位、是否丢弃历史推理、`providerOptions`、顶层 `reasoning` 与排好序的 header 名；header 值可能是凭据，不计入 |
| 工具结果的图片 | 模型支持视觉（`capabilities.vision`）时，带图片的工具结果发成内容（文本 + 图片文件）；不支持时发文本，末尾加一行"[图片 N 张：模型不支持视觉，未展示]" |
| 应用调用参数 | 应用为模型声明的 `callSettings`：`providerOptions` 按厂商键与上面的 reasoning 参数逐字段合并，同一字段应用优先（具体的厂商参数优先于通用的推理档位，与 AI SDK 一致）；`headers` 与 AI SDK 的顶层 `reasoning` 原样传入。参数随模型配置固定。顶层 `reasoning` 与上面的 reasoning 参数是同一件事的两个通用开关，只能给一个，两个都给时创建提供方即报错 |
| 消息规整 | `systemAfterUser=false` 的厂商：把 user 之后的 system 消息改写成带固定标记的 user 内容。清洗泄漏的工具调用标记 |
| 推理回放 | 推理内容和签名原样带回；某个模型不能稳定接受带签名的回放时，适配器可以配置为丢弃历史推理内容 |
| 工具选择 | 只在兜底交付时用 `toolChoice = 'none'`，工具定义照常传入；厂商不支持时忽略返回的工具调用 |
| 缓存断点 | 仅 Anthropic，ephemeral（5 分钟）：打在稳定前缀末尾（能力说明之后）和运行记录末尾，两处重合时只打一个 |
| 用量归一 | 优先读 `inputTokenDetails`，读不到再扫描 `providerMetadata`，统一为 `{ input, output, cacheRead, cacheWrite }`；有价格表时同时算出费用 |

### 8.2 工具流水线

```ts
interface ToolDef {
  name: string
  description: string
  inputSchema: ZodType | JSONSchema7
  execute(input: unknown, ctx: ToolCtx): Promise<unknown>
  validate?(input: unknown, ctx: ToolCtx): { ok: true } | { error: ToolErrorEnvelope }
  safety?: {                                   // 供权限和审批使用
    access?(input: unknown): { read?: string[]; write?: string[]; network?: boolean }
    risk?: 'low' | 'high'
  }
  execution: {                                 // 供流水线使用
    effect: 'none' | 'idempotent' | 'side_effect'    // 必填，没有缺省值
    exclusive?: boolean
    timeoutMs?: number                         // 默认 30 秒
    maxOutputChars?: number                    // 默认 8KB
  }
  semantics?: {                                // 供判定和监督使用
    intent?: { kind: 'complete' | 'await_input' | 'stop'; code: string }
    repeatable?: boolean                       // 轮询类工具，封路与无新信息守卫不统计
  }
}
interface ToolCtx {
  runId: string; callId: string
  idempotencyKey: string
  scope: TaskScope
  task: { subject?: string; context?: Readonly<Record<string, JsonValue>> }   // 任务的归属和业务上下文
  signal: AbortSignal
  spawn(agent: Agent, task: Task, opts?: { environment?: Environment }): Promise<RunResult>
  progress(note: string): void
  callModel(req: SideModelRequest): Promise<SideModelResponse | undefined>
  // 经引擎调用模型：记为 external_call（来源 tool:<工具名>/<用途>），计入预算与 tools 用量（I8）；
  // 跟随这次调用的取消与超时，不另加组件时限
}
// 内容块结果：工具返回 toolContent([...文本块, ...图片块])，判断只认结构化标记 __agent_content
function toolContent(parts: Array<TextPart | ImagePart>): { __agent_content: true; parts: Array<TextPart | ImagePart> }
```

`ToolDef` 可以装饰：工具结果缓存、按数据源限频、计费。

| 环节 | 做什么 | 失败时的信封 |
|---|---|---|
| a 查找 | 是否在本步可见集合中 | `TOOL_NOT_AVAILABLE`（提示先调用 `search_tool`） |
| b 封路 | 是否命中生效的封路（工具名 + 输入哈希） | `TOOL_BLOCKED`（原因、封住的步、替代做法、"再调用将收尾"） |
| c 参数校验 | 校验所有声明的字段；诊断包括缺了哪些、传了哪些、期望的 schema、拼写相近时的"你是不是想用 X" | `INVALID_INPUT` |
| d 工具自校验 | 调用 `validate` | 工具给出的信封 |
| e 权限与审批 | 执行环境的权限规则；需要时等待委托人审批 | `PERMISSION_DENIED` / `USER_DENIED`；审批人稍后答复为 `APPROVAL_PENDING`；规则自己没能判断（出错、hook 超时）为 `PERMISSION_UNAVAILABLE`，审批没有回应或审批服务出错为 `APPROVAL_TIMEOUT` / `APPROVAL_UNAVAILABLE`（都拒绝调用，但按暂时性错误处理） |
| f 熔断 | 所属依赖的熔断器是否打开 | `TOOL_UNAVAILABLE` |
| g 执行 | 超时即中止，取消信号传给工具；意图工具只返回简短确认 | `TOOL_TIMEOUT` / `TOOL_ABORTED` / `TOOL_EXCEPTION` |
| h 规整 | 识别错误信封；内容块结果的文本块拼成正文，图片转成 base64 另存（单张不超过 5,242,880 字节，超出换成一行说明；每次最多 8 张，其余写一行说明；字符串图片只接受 base64）；超长时保留头尾截断并注明原始长度；外面包一层 `<tool_output>` | 内容块不合格（未知类型、URL 图片）：`TOOL_EXCEPTION` |

错误信封的格式为 `{ __agent_error: true, code, message, hint? }`，判断出错只认这个结构化标记。`APPROVAL_PENDING` 是引擎保留的码：工具自己返回它时改为 `TOOL_EXCEPTION`，只有审批环节和等审批的子运行能给出它。引擎另外定义：`TOOL_MISSING_RESULT`、`TOOL_INTERRUPTED`、`OUTPUT_INVALID`、`INTENT_NOT_ALONE`、`APPROVAL_PENDING`（审批稍后答复，调用没有执行；子运行因此结束时，委托工具返回同一个码）、`SPAWN_DEPTH_EXCEEDED`、`SPAWN_CYCLE`、`SPAWN_BUDGET`、`SPAWN_LIMIT`。工具可以定义自己的错误码。

### 8.3 能力宿主

| 宿主 | 提供什么 | 要点 |
|---|---|---|
| `mcpHost` | 连接、工具列表、调用 | 按服务器规格的指纹复用连接；默认不预连接，只预连接应用给出的列表；工具列表变化时更新版本；按服务器熔断；stdio 服务器作为独立进程管理；状态通过 `engine.onHealth` 通知 |
| `skillHost` | 激活工具 | 多个 skill 共用一个激活工具；激活内容不超过 20000 字；history 里已激活过的 skill 返回"已激活，见前文" |
| `delegationHost` | 委托工具、`ctx.spawn` | 多个子 agent 共用一个委托工具，参数里用枚举选择；规则见下表 |
| `hookRunner` | 执行 hook 命令 | 独立进程，带超时，遵守 Claude Code hook 协议；调用记为 `external_call` |

**子运行规则**

| 方面 | 规则 |
|---|---|
| 执行环境 | 默认沿用父运行的；也可以指定别的执行环境，但父运行生效的权限规则会排在子运行自己的规则前面一起生效，子运行的权限只能更严（I4） |
| 模型 | 子 agent 的偏好 > 父运行的模型 > 模型库默认值；同样核对子 agent 的要求（§1.8） |
| 深度 | 不超过 `caps.delegation.depth`（默认 3），超出返回 `SPAWN_DEPTH_EXCEEDED` |
| 防环 | 沿血缘检查 `agent.id`，不允许委托给自己或任何祖先：`SPAWN_CYCLE` |
| 预算 | 不超过父运行的剩余额度：`SPAWN_BUDGET`；父运行和子运行都没有时长上限时，子运行用 10 分钟；剩余额度扣除正在运行的子运行预留的费用，并行委托不会各拿一份；父运行有费用上限而子运行的模型没有价格时拒绝委托（`SPAWN_BUDGET`）；子运行的用量计入父运行，调用工具已经返回后才结束的子运行也计入 |
| 取消与日志 | 子运行挂在取消树上，有独立的日志；发起委托的工具调用超时或被取消时，它的子运行随之取消；父运行结束时最多等 `childDeliveryWaitMs`（默认 10 秒），之后取消还在运行的子运行；父运行的 `tool_finished` 记录 `childRunId`（一次调用发起多个时 `childRunIds` 全部列出）。子运行的时长上限是父运行剩余时长减去父运行的收尾预留；标准委托工具把父运行的工作区（`scope`）带给子运行 |
| 结果 | 委托工具把子运行的 `RunResult` 映射成文本或 `SUBAGENT_*` 信封 |

### 8.4 交付的执行

- **生效的交付物**：任务给了交付物，就整体替换 Agent 的默认交付物；没给就用默认值。执行环境的强制验收总是叠加在后面。
- **submit 工具**（结构化交付时由输出契约在准备环节提供）：意图为"完成"，inputSchema 就是输出 schema。依次通过 schema 校验和领域校验才算通过；不通过时返回 `OUTPUT_INVALID`，并计一次自修。
- **兜底的三级退化**：

  | 级别 | 做法 |
  |---|---|
  | 0 | 上一次视图接上本步的回复和工具结果 + 兜底说明 + 副作用清单，禁用工具调用一次模型，最长用时为收尾预留时长与离截止剩余时间中较小的一个 |
  | 1 | 改用最小视图（须知 + Agent 指令 + 任务输入 + 兜底说明）再调用一次 |
  | 2 | 直接使用兜底的固定文本 |

  产出的文本最后经过 `sanitize`。

### 8.5 运行档案

```ts
interface ArchiveStore {
  append(runId: string, events: RunEvent[]): Promise<void>        // 原子写入，seq 必须连续
  read(runId: string, fromSeq?: number): AsyncIterable<RunEvent>  // 读取时经过升级器
  putBlob(data: string | Uint8Array): Promise<BlobRef>            // 按 sha256 去重
  getBlob(ref: BlobRef): Promise<string | Uint8Array>
  query(filter: RunFilter): Promise<RunSummary[]>
  pin(runId: string, reason: string): Promise<void>
  retain(policy: RetentionPolicy): Promise<RetainReport>          // 会话按整体过期
  deleteSession(session: string): Promise<RetainReport>           // 整个会话（含子运行与固定的运行）；有没结束的运行时拒绝
}
```

自带内存实现和 SQLite 实现（`sqliteArchive({ file, retention })`）。应用删除会话用 `engine.deleteSession`：先占住会话（`session_busy`），再调用档案；档案里有没结束的运行时返回 `session_open`。

```sql
runs   (run_id PK, root_run_id, parent_run_id, environment, environment_fp, engine_fp,
        agent_id, agent_version, agent_fp, model, subject, session, turn, continues,
        status, code, started_at, ended_at, steps, tool_calls,
        input_tokens, output_tokens, cache_read, cache_write, memory_tokens, supervision_tokens, cost,
        pinned, schema_version)               -- 物化的运行摘要，可以从 events 重建
events (run_id, seq, type, at, payload, PRIMARY KEY (run_id, seq))
blobs  (sha PK, size, encoding, data, created_at)
meta   (key PK, value)
-- 索引：runs(subject, started_at)、runs(parent_run_id)、runs(root_run_id)、
--       runs(agent_id, agent_version, started_at)、runs(environment, status, started_at)、
--       runs(session, turn)
```

| 方面 | 做法 |
|---|---|
| 写入 | WAL，`synchronous=NORMAL`；一次 `append` 是一个事务，包含一个环节产生的全部事件和 blob；在 `run_started`、`step_ended`、`run_ended` 时更新 `runs`；超过 4KB 的 blob 用 gzip 压缩 |
| 读取 | 按 seq 流式读出，blob 按需加载；应用优先使用投影 API |
| 保留 | 按执行环境配置保留天数，默认 30 天；被 pin 的运行永久保留；会话按整体过期：会话里的每个运行（含子运行）都过期了才一起清理，有固定的运行时整个会话保留；清理后对 blob 做标记清除 |
| 版本 | 表结构版本记在 `meta.schema_version`，版本不同的文件拒绝打开，不做迁移；事件格式版本记在 `run_started.schemaVersion`，读取时由升级器升级 |
| 性能 | 单写多读；按环节批量提交；宿主进程卡顿时把引擎整体迁到独立的工作进程 |

### 8.6 估算器

全局唯一的 token 估算器（`core/estimate`），超限检查与记忆共用：中日韩字符按 0.67、其他字符按 0.25 计，图片按 85 计；用上一次的实际输入量校准，系数限定在 0.5–2 之间。

---

## 9. 组件契约

### 9.1 共用部分

```ts
interface Component {
  id: string; version: string
  mode?: 'active' | 'shadow'
}
interface RunInfo {
  runId: string; parentRunId?: string; rootRunId: string
  environment: { name: string; principalReachable: boolean }
  agent: { id: string; version: string }
  task: { subject?: string; tags?: Record<string, string>; scope?: TaskScope;
          context?: Readonly<Record<string, JsonValue>> }
  model: { ref: ModelRef; contextLimit: number }
}
interface ComponentCtx {
  clock: Clock; random: () => number
  callModel(req: SideModelRequest): Promise<SideModelResponse | undefined>   // 记为 external_call，计入预算
  record<T>(name: string, fn: () => Promise<T>): Promise<T>                  // 其他外部调用，重放时读日志
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown): void   // 写诊断日志，不进运行日志
}
```

组件可以从 `RunInfo` 读取场景信息（委托人能否联系上、模型窗口），自行调整行为。

### 9.2 工具呈现 `Exposure`

```ts
interface Exposure extends Component {
  tools?: ToolDef[]                          // 呈现方式需要的系统工具，例如 search_tool
  start(run: RunInfo, ctx: ComponentCtx): {
    visible(state: ToolboxState): string[]   // 必须是已准备工具的子集
  }
}
```

标准实现 `searchExposure()`：
- 准备结果为 `deferred` 的工具一开始只露出 `search_tool`；没有延后工具时，`search_tool` 也不露出。
- `search_tool({ query, server? })` 用检索器（`ToolRanker`，缺省 `bm25Ranker()`：名字、描述、能力 id，中文按单字与相邻两字切词，查询里多字词切出的单字权重 0.3，免得中文词的分量压过英文词）打分排序，只加载命中的前 8 个；没有命中时只返回各服务器的工具数，不加载。应用可以经 `searchExposure({ ranker })` 换成自己的检索器，检索器出错时本次改用 BM25。
- 本次运行内可见集合只增不减：常驻工具 → `search_tool` → 搜到过或调用过的延后工具（按加载先后，新加载的追加在末尾，不打碎提示词前缀）；同时可见的延后工具最多 40 个，超出时淘汰最早加载且未调用的。
- 延后工具不超过 20 个时直接全部可见，不露出 `search_tool`。`compose` 按呈现方式给出的顺序排列工具。
- 调用过的延后工具，在本次运行内一直可见。

### 9.3 记忆 `Memory`

```ts
interface Memory extends Component {
  start(run: RunInfo, ctx: ComponentCtx): {
    recall(state: MemoryState): Promise<MemoryView>
  }
}
interface MemoryState {
  step: number
  history: ModelMessage[]
  transcript: ModelMessage[]
  contextLimit: number
  inputLimit: number                                  // 模型窗口减去输出预留
  fixedTokens: number                                 // 须知、指令、能力说明、任务输入、尾部、工具定义
  estimate(messages: ModelMessage[]): number
  summary?: string                                    // 会话的一轮：history 第一条是带入的摘要时的正文
  turnStarts: number[]                                // 每一轮在 history 里的起点；不带会话的运行为空
}
interface MemoryView {
  compaction?: { upTo: number; summary: string }      // history + 运行记录的前 upTo 条换成摘要；每一步给出当时生效的压缩
  notice?: string                                     // 本步附在尾部的提示，不进运行记录
}
```

记忆只给出决定，视图由引擎渲染（`renderView`）：组装、会话的下一轮窗口与预览用同一个函数，模型看到的前文只可能是原样的前文，或者套上一次已声明的压缩。记忆拿到的是深拷贝；记忆出错、超时或决定不合格时沿用上一步生效的压缩，压缩不会因为记忆失败而退回。须知、Agent 指令、能力说明、任务输入由核心原样放入固定布局。

### 9.4 守卫 `Guard`

```ts
interface Guard extends Component {
  onError?: 'ignore' | 'stop'          // 出错或超时：默认视为没有意见；'stop' 时停止，code guard_error:<id>
  start(run: RunInfo, ctx: ComponentCtx): {
    check(facts: StepFacts): GuardOpinion | undefined | Promise<GuardOpinion | undefined>
  }
}
type GuardOpinion = { detail?: string } & (
  | { warn: { problem: string; suggest?: string; block?: CallBlock[] } }   // 告知，可带封路
  | { awaitInput: { code: string } }
  | { end: { as: 'finalize' | 'stop'; code: string } }                      // 终止
)
interface CallBlock { tool: string; inputHash: string; code: string; reason: string; suggest?: string }
interface GuardGroups { task?: Guard[]; environment?: Guard[]; capability?: Guard[]; engine?: Guard[] }
```

守卫是唯一的监督扩展概念：看本步事实（观察）、在 `start` 返回的运行内实例里记自己的账、给出意见（反思）。守卫不能给出完成；告知由核心统一渲染成纠偏消息。计数类守卫用 `thresholdGuard(spec)` 写：计数 + 告知阈值 + 终止阈值，先告知再终止。读外部状态时用 `ctx.record` 留痕。详见 docs/guard-mechanism.md §3。

### 9.5 预算守卫与纠偏消息

预算守卫（核心内置，来源 `guard:pressure`）在步数剩余 ≤ 1 步或已用 95%、时间 / token / 费用 / 上下文已用 90% 时告知一次（每个维度每次运行一次，引导后重来）；预算用完时的终止仍由 ⑥ 合并后的核心检查负责。

纠偏消息（来源 `steering`，每步最多一条）由 `renderSteering` 渲染：`[纠偏 · 第 N 步]`、目标、发现、已封住的调用（最多列 5 个，每个带原因和建议；带封路的告知在发现里只列问题，不重复原因和建议）、剩余步数与时间、复盘要求、出口（直接作答；本次运行有 `ask_user` 时可以询问委托人；有停止类意图工具时说明原因），整条不超过 2000 字；超长时截的是前面的正文，剩余预算、复盘要求与出口完整保留。撞上封路的调用返回 `TOOL_BLOCKED`：`该调用已被封住：<原因>（第 N 步）`，提示 `<建议>。再调用将收尾`。

### 9.7 意见、干预、观察与意图

```ts
type Opinion =
  | { continue: { interventions?: Intervention[] } }
  | { complete: true }
  | { awaitInput: { code: string } }
  | { finalize: { code: string } }
  | { stop: { code: string; message: string } }
type Verdict = Opinion & { sources: string[] }

type Intervention = { hint: { text: string } } | { block: CallBlock }
    // 封路按调用（工具名 + 输入哈希）匹配，持续到运行结束；委托人引导生效时全部解除

interface StepFacts {
  step: number
  text: string
  toolCalls: Array<{ name: string; capability: string; inputHash: string; outputHash: string;
                     ok: boolean; errorCode?: string; errorClass?: 'deterministic' | 'transient';
                     effect: ToolEffect; durationMs: number; blocked: boolean;
                     repeatable?: boolean; intentTool?: true; inputPreview?: string; outputPreview?: string }>
  allToolsFailed: boolean | null
  intent?: { tool: string; kind: 'complete' | 'await_input' | 'stop'; code: string }
  isFinalCandidate: boolean
  newInformation: boolean
  finishReason: ModelResponse['finishReason']
  interventions: { applied: Array<{ kind: string; source: string }>; violated: Array<{ source: string; code: string }> }
  pressure: { context: number; steps: number; time: number; tokens: number; cost: number }
  stepsLeft?: number
  usage: NormalizedUsage
}
type Observation = StepFacts
```

**意图工具**（由能力 `intents()` 提供）

| 工具 | 意图 | code | 委托人联系不上时 |
|---|---|---|---|
| `finish` | 完成 | `finish` | 保留 |
| `ask_user` | 等待输入 | `ask_user` | 排除 |
| `propose` | 等待输入 | `propose` | 排除 |
| `report_blocked` | 停止 | `blocked` | 保留 |

- 委托人联系不上时，使用说明里会写明"不要在回答里向委托人提问；缺少关键信息无法继续时，调用 report_blocked 说明缺什么"。
- 意图工具照常走流水线，返回简短确认以保持成对，然后把意图作为一条意见交给判定。
- 意图工具必须单独调用；和其他工具一起调用时返回 `INTENT_NOT_ALONE`，其余工具照常执行。
- 以意图结束时，`RunResult.intent` 带上该调用的参数。`propose` 的参数包括摘要、预览和待确认的动作；`validate` 要求动作里的工具在本次运行的工具集中；委托人确认后作为下一次运行的输入。
- submit 属于同一类：意图为完成，由交付环节校验和验收。

### 9.8 输出契约 `OutputContract` 与兜底 `Fallback`

```ts
interface OutputContract extends Component {
  kind: 'text' | 'structured'
  tools?: ToolDef[]                                   // 结构化交付时提供 submit，须带 intent { kind: 'complete' }
  schema?: { safeParse(v: unknown): ... }             // 交付环节先用它解析提交的参数；不合格计入 maxRepairs
  validate(candidate: Candidate, ctx: ComponentCtx):
    Promise<{ ok: true } | { ok: false; issues: string[]; hint: string }>   // 读业务状态时经 ctx.record 留痕
  sanitize?(text: string, corpus: Corpus): string     // 用于兜底交付的文本
  maxRepairs?: number                                 // 默认 3
}
interface Candidate { step: number; text?: string; output?: unknown; observation: Observation }
interface Fallback {
  instructions: Record<string, { reachable: string; unreachable: string }>   // 按收尾 code，按委托人能否联系上
  fixedText: string
}
```

### 9.9 验收 `Check`

```ts
interface Check extends Component {
  mode: 'gate' | 'annotate' | 'shadow'
  maxAttempts?: number                  // gate 模式下每次运行最多退回几次，默认 1
  start(run: RunInfo, ctx: ComponentCtx): {
    accept(candidate: Candidate, corpus: Corpus): Promise<{ pass: true } | { pass: false; issues: string[]; hint: string }>
  }
}
```

| 模式 | 行为 |
|---|---|
| `gate` | 不通过 → 带提示退回，计次；次数用完后放行，问题写入 `quality` |
| `annotate` | 定稿之后执行，结果写入 `quality` |
| `shadow` | 只记录 |

### 9.10 权限、委托人、须知与 hook 适配

```ts
interface PermissionRule extends Component {
  permit(call: ToolCallView, run: RunInfo, ctx: ComponentCtx): Promise<'allow' | { deny: string } | { ask: AskRequest }>
}
interface AskRequest {
  summary: string
  risk: 'low' | 'high'
  detail?: { paths?: string[]; reason?: string; input?: string }
}
interface Approver {
  approve(req: AskRequest & { callId: string; toolName: string }, run: RunInfo):
    Promise<{ approved: boolean; remember?: { scope: 'session' | 'always'; pattern?: string } }
          | { defer: string }>     // 稍后答复，写原因
    // "本会话记住"由实现按 run.task.subject 区分（会话的一轮缺省为会话 id）
}
interface NoticeProvider extends Component {
  provide(run: RunInfo, ctx: ComponentCtx): Promise<Segment[]>
}
function adaptHooks(specs: HookSpec[], opts?: { toolView?: (v: HookToolView) => HookToolView }): {
  notice: NoticeProvider[]; permissions: PermissionRule[]; guards: Guard[]; checks: Check[]
}
// 应用可以用 toolView 把工具名与输入映射成 hook 期望的形状（例如 Claude Code 的 Write、file_path）；
// 映射只影响 matcher 匹配与 hook 输入，拒绝与询问的消息仍用真实工具名；映射出错时按原名执行并记警告。
interface HookToolView { toolName: string; input: unknown }
interface HookSpec {
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'
       | 'Stop' | 'SubagentStop' | 'PreCompact' | 'Notification'
  matcher?: string
  command: string
  timeoutMs?: number                    // 默认 10 秒
  source?: string
}
```

**权限的组合**

- 任意一条拒绝，就拒绝。
- 没有拒绝、但至少一条询问时，交给委托人审批；多条询问合并成一次审批。
- 委托人联系不上，或没有配置审批时，询问按拒绝处理。
- "记住"由审批的实现保存；权限规则通过配置读取已授权的范围，读取经 `ctx.record` 留痕。
- 审批人可以稍后答复（`{ defer }`，例如要等律师复核）：这次调用不执行，结果为 `APPROVAL_PENDING`，`approval_answered` 记 `deferred`，这一轮以 `awaiting_input` / `approval_pending` 结束（§3.10）。批准记录由审批人自己保存；委托人答复后开会话的下一轮，模型再次发起同一调用时审批人直接回答。引擎不在下一轮代为执行（I15）。子运行的调用被延后时，父运行同样以 `approval_pending` 结束。

**hook 翻译**

| hook | 翻译成 | 环节 |
|---|---|---|
| SessionStart、UserPromptSubmit | 须知生成：纯文本输出作为须知，JSON 输出只取 `additionalContext`；UserPromptSubmit 退出码 2 或 `decision: block` 时拦下运行（`stopped` / `notice_blocked`）；UserPromptSubmit 跑不起来（例如没配 hook 执行器）、超时或被结束时同样拦下，SessionStart 只记日志 | 准备 |
| PreToolUse | 权限规则；hook 启动失败或超时按拒绝处理（§4.4，标为规则没能判断：`PERMISSION_UNAVAILABLE`），其他非 0、非 2 的退出码放行并写警告 | ③ 行动 |
| PostToolUse | 守卫：只在调用成功后运行，hook 的反馈作为告知；能完整解析的输入输出按 JSON 对象传给 hook | ⑤ 反思 |
| Stop | 根运行的强制验收（`gate`）；之前拦过时 `stop_hook_active` 为 true | 交付 |
| SubagentStop | 子运行的强制验收 | 子运行的交付 |

MCP 工具在引擎里叫 `<服务器名>__<工具名>`，交给 hook 匹配和上报时用 Claude Code 的写法 `mcp__<服务器名>__<工具名>`。
| PreCompact、Notification | 只作为通知交给应用 | — |

---

## 10. 标准监督与验收

标准守卫是引擎守卫的默认实现（`standardGuards()`）；标准验收是交付物和执行环境可选用的验收组件。守卫机制的完整方案、设计依据与场景矩阵见 docs/guard-mechanism.md，本章只列实现后的要点。

### 10.1 标准守卫

| 守卫 | 来源 | 计什么 | 告知 / 终止（默认） | 终止 code |
|---|---|---|---|---|
| 封路 `roadblock()` | 引擎 | 每个调用（工具名 + 输入哈希）一本账：确定性错误第 1 次、有副作用且结果未知（可能已经执行）第 1 次、瞬时错误第 2 次失败封住；相同输入连续两次返回相同结果封住；有副作用的操作以相同输入第 2 次成功后封住。轮询类工具、意图工具、撞上封路的调用不记账 | 封住当步告知，建议按错误给：`INVALID_INPUT` 按错误信息修正参数（输入不同不受封路影响）；没有权限、委托人拒绝在本次任务里不要重试，也不要换工具或换写法去做同一件事（规则明确拒绝与委托人拒绝的错误信封也带同样的提示；拒绝只约束这次运行，之后的任务里规则或决定可能已经变了）；瞬时错误不要用相同输入重试；结果没有变化就基于已有结果决定下一步。依赖环境状态的封路（失败、结果不变、重复执行副作用）在之后有别的写操作（`side_effect`）成功时解除，纠偏消息注明；输入不合法、被拒绝、结果未知的封路不解除。再调用被封的调用 → 收尾 | 封路自带：`failure_streak`、`user_denied`、`spawn_failed`、`external_failure`、`repeat` |
| 失败连击 `failureStreak` | 引擎 | 连续"本步工具调用全部失败"的步；子运行失败计 2；有成功清零。建议按错误类别给：有确定性错误时修正参数或前提条件，全是瞬时错误时不要用相同输入反复重试 | 2 / 3 | `failure_streak`；失败一半以上是 `TOOL_UNAVAILABLE` 时 `external_failure` |
| 无新信息 `noNewInfo` | 引擎 | 连续有调用却没有新信息的步；只调用轮询类工具的步不计；成功执行的副作用算进展（批量写入每次返回相同的确认不是原地打转） | 3 / 8 | `stall` |
| 截断 `truncation` | 引擎 | 连续 `finishReason = length` | 1 / 3（收尾，兜底要一份精简的结果） | `truncated` |
| 静默推进 `silentProgress` | 引擎 | 连续只调用工具、没有文本说明的步 | 5 / 不终止 | — |
| 计划推进 `progressGuard` | 规划能力 | 计划建立后没有新计划输入的步 | 6 / 12 | `no_progress` |
| 预算守卫 `budgetGuard` | 核心内置 `guard:pressure` | 步数剩余 ≤ 1 或 95%；时间（按收尾预留之前的可用时长）、token、费用、上下文 90% | 每个维度告知一次 | — |
| 顾问 `modelAdvisor(opts)` | 可选，加入引擎守卫 | 纠偏后仍失败，或每 5 步周期检查发现异常时调一次模型；每次运行最多 3 次、间隔 ≥ 3 步（引导后不清零）；置信度 ≥ 0.5、封住的调用在窗口内且不是意图工具或轮询类工具、建议没给过才采纳 | 只告知与封路 | — |

- 阈值用 `standardGuards({ thresholds })` 调整；`silentProgress: false` 关闭静默推进。
- 错误类别：`INVALID_INPUT`、`PERMISSION_DENIED`、`USER_DENIED`、`SPAWN_*` 为确定性错误，其余为瞬时错误（`classifyError`）；工具可以在错误信封里用 `errorClass` 声明自己的类别，优先于按错误码判断；只认 `deterministic` 与 `transient`，其他值按没写处理。
- 业务守卫随任务、执行环境或能力提供，与标准守卫一起参与裁决。

### 10.2 先告知后终止

守卫的终止意见只有在同一来源已经告知过（运行开始或最近一次引导之后）时才生效；否则本步改为告知"守卫判定需要收尾（code）；问题如果持续，下一步将收尾"，记 `deferred`。计数守卫的告知带剩余次数，例如"连续 2 步工具调用全部失败（2/3，再出现 1 次将收尾）"。结束时自检 I16。

### 10.3 干预

| 干预 | 怎么执行 | 约束 |
|---|---|---|
| 纠偏消息 | 下一步 ① 以 system 角色追加到运行记录，来源 `steering`，正文自带标题、不加来源前缀 | 每步最多一条；单条发现 400 字、发现合并 1200 字、整条 2000 字 |
| 封路 `block` | 工具流水线 b 环节按"工具名 + 输入哈希"匹配；命中时不执行，返回 `TOOL_BLOCKED`；工具列表不变 | 持续到运行结束；委托人引导生效时全部解除 |

- **违规**：再次调用被封住的调用，本步收尾（来源 `guard:violation`），code 取封路的 code。
- **合并**：多条封路取并集。

### 10.4 顾问 `modelAdvisor`

**输入**（确定性构造，有长度上限）：任务目标（最多 1500 字）；最近 10 步的轨迹（文本、工具名、输入哈希、参数摘要、成败与错误码、输出摘要，每项最多 200 字）。

**输出**：`{ problem, suggest, block?: [{ tool, inputHash }], confidence }`。采纳后告知（detail `顾问`），封住的调用 code 为 `repeat`、原因为 `顾问判断：<problem>`。模型调用记为 `external_call`（`<来源>/supervision:advise`），计入预算；没有回复、不是 JSON、字段不合法时没有意见。

### 10.5 委托人干预

| 方式 | 时机 | 行为 |
|---|---|---|
| 引导 `run.steer(text)` | 任何时刻 | 记一条 `steer_received`；到下一步 ① 时以 user 角色追加到运行记录；封路全部解除，所有守卫重新开始；多条引导合并成一条；在本步结束前到达的引导优先于完成、收尾和等待输入（§4.3 引导优先） |
| 审批 | 工具流水线 e 环节 | §9.10 |
| 中止 `run.abort()` | 任何时刻 | §3.14 的取消树 |

运行以 `awaiting_input` 结束后，委托人的回复作为会话的下一轮（§3.15）；不带会话时，开启新的一次运行并带上之前的 history。

### 10.6 标准验收

| 验收 | 方式 | 不通过时 | 建议模式 |
|---|---|---|---|
| 引用核对 `groundingCheck` | 确定性：引号内 ≥ 20 字节的引文和实体名，在语料中找不到就算无法核实；累计 ≥ 2 处不通过。比较前规范化数字（千分位、小数位、百分号）和单位（"万""亿"等） | 提示，列出无法核实的内容，要求修正或删除 | 先用 `shadow` 校准；准确后交互场景用 `annotate`，高风险后台任务用 `gate` |
| 完成审查 `completionReview`（`createEngine` 默认带上） | 先做风险打分，≥ 3 分才调用模型。打分项：要求执行操作（含预订、购买、支付等）或查找信息（查、搜索、检索、核实等，不含检查、审查）却没调用任何工具 +5；回答结尾在预告动作（"我先查一下""稍等，我马上为你查询""let me look that up"）+5；声称已写入却没有副作用调用 +4；任务有多项但工具调用很少 +3；请求超过 100 字而回答不足 50 字 +2；声称全部完成且已运行 5 步以上 +4；还有未完成的计划项 +3；委托人联系不上而回答在向委托人提问 +3。模型判定未完成、置信度 ≥ 0.5 并列出未完成项，才算不通过；联系不上时判定输入带 `principalReachable: false`，向委托人提问算未完成 | 提示，列出未完成项；缺工具时提示先用 `search_tool`；联系不上时提示直接给出结果或用 `report_blocked` 说明缺什么；回答在预告动作时提示直接调用工具去做 | `gate`，每次运行最多退回 2 次 |

验收只给出问题和提示，由主模型自己修正；不改写交付内容。

### 10.7 留痕与统计

- 纠偏消息以 `[纠偏 · 第 N 步]` 开头，其他提示带来源标签（例如 `[delivery]`、`[check:completion]`）；工具结果一律包在 `<tool_output>` 里，工具输出伪造不了提示。不支持 system 角色的厂商，由适配器转成固定的标记结构。
- 每一步的事实、守卫意见（含影子模式、`detail`、`deferred`、`error`）、裁决写入 `evaluated`；每次交付尝试写入 `delivery_checked`；实际执行的干预写入 `intervention_applied`；顾问和验收的模型调用写入 `external_call`。
- `SupervisionStats` 可以按运行汇总，也可以按"Agent 指纹 × 模型 × 执行环境 × 引擎指纹"汇总。统计项包括（详见 docs/guard-mechanism.md §3.5）：
  - 每个来源的告知与终止次数、顺延次数；
  - 纠偏消息条数、告知有效数（告知之后同一来源没有再要求终止）；
  - 封路违规次数；
  - 顾问调用与采纳次数；
  - 守卫导致的收尾或停止次数；
  - 验收的通过率与退回次数、影子模式下"本来会拦截"的次数；
  - 守卫与验收的模型开销；
  - 重跑之后的成功率。

### 10.8 复盘与重跑

**`RunRetrospective` 投影**（确定性）：问题时间线（守卫信号：告知 / 终止 / 等待输入、detail、是否顺延；干预）、交付记录、结束原因、已执行的副作用清单、用量与耗时、子运行概况。

**`retrospect.brief(retro)`**：确定性地生成一段说明，包括上次试了什么、卡在哪里、已执行的副作用。

**重跑**：引擎不在运行内回退或换模型。需要重来时，由应用开启新运行，引擎为此提供：
- 结局和 `code`，供应用判断是否值得重跑；
- `retrospect.brief`，追加到新任务的输入里；
- 启动时的模型指派，用于换模型；
- `tags.retryOf`，关联前后两次运行，供统计重跑效果。

什么时候重跑、由谁触发、重跑几次，由应用决定。

---

## 11. 标准组件库（`stdlib/`）

引擎的记忆和监督不配置时，使用这里的标准实现；其余组件需要显式选用。标准组件只使用公开 API，和第三方组件地位相同。

| 槽位 | 标准组件 | 要点 |
|---|---|---|
| 能力 | `tool()`、`tools()`、`mcp()`、`skill()`、`subagent()`、`planning()`、`intents()`、`bundle()` | §4.2 |
| 工具呈现 | `searchExposure()` | §9.2 |
| 记忆 | `compactingMemory(opts)` | 见下 |
| 守卫 | `standardGuards({ thresholds })`、`roadblock()`、`thresholdGuard(spec)`、`modelAdvisor({ model })`；规划能力的 `progressGuard` | §10.1–§10.4；顾问默认使用运行的模型 |
| 输出契约 | `text({ sanitize })`、`structured(schema, { validate, maxRepairs })` | §9.8 |
| 兜底 | `standardFallback()` | 各收尾 code 的说明，分委托人联系得上和联系不上两个版本 |
| 验收 | `groundingCheck(opts)`、`completionReview({ model })` | §10.6；完成审查默认使用运行的模型；`createEngine` 的默认交付物带完成审查，交付物不写 `checks` 时沿用默认，写 `checks: []` 表示不要验收 |
| 权限规则 | `workspaceSandbox({ sensitive, granted })` | 只对声明了 `access` 的调用生效；工作区来自任务的作业范围；路径按操作系统的语义解析（逐段先跟随符号链接，再处理 `..`）；敏感路径与授权路径也取 realpath；敏感路径直接拒绝；工作区内放行；工作区外先查 `granted`，没授权就询问，并在 `detail` 里带上路径和原因；前缀比较带路径分隔符；家目录类敏感路径先展开再匹配 |
| | `riskApproval({ mode })` | `auto`（只记审计）、`ask-high`、`ask-all`；对 low 级工具的参数做兜底正则检查，命中就升级为询问；high 级工具确认摘要为空时直接拒绝 |
| hook 适配 | `adaptHooks(specs)` | §9.10 |
| 格式解析 | `parseSkill(dir)`、`parsePlugin(dir)`、`parseMcpConfig(json)` | 只解析标准格式；读哪些目录由应用决定 |
| 复盘 | `retrospect.brief` | §10.8 |
| 观测导出 | `otelExporter(opts)`、`langfuseExporter(opts)` | 订阅者：把运行事件转换成外部追踪工具的数据；失败只写诊断日志（§6.6） |
| 文本处理 | `grounding` | 引用核对函数被 `groundingCheck` 和 `grounding.sanitize` 共用；`sanitize` 把无法核实的内容替换为 `⟨unverifiable⟩` 或 `⟨ungrounded:X⟩` |

**`compactingMemory`**（`{ trigger, turnStart, keepRatio, keepRecentTokens, summaryRatio, maxHistoryTokens, anchors, model }`）

- 各条线按可用空间（输入上限减去固定占用）计算：第 1 步带入的前文超过 `turnStart`（默认 0.5）、任一步前文 + 运行记录超过 `trigger`（默认 0.8）时触发；`maxHistoryTokens` 给出时，可用空间按 min(可用空间, 它 ÷ `turnStart`) 计算。
- 保留不超过 `keepRatio`（默认 0.1，`keepRecentTokens` 给出绝对值时以它为准）的最近原文，切点落在成对边界上；切点落在以前各轮里时顺延到下一轮的起点；本轮最近 `anchors` 组（默认 1 组）工具交换超过保留线也保留。
- 其余内容压成 5 个字段的结构化摘要：意图、关键事实、未完成的动作、已解决的问题、当前阻塞。摘要请求的 `maxOutputTokens` 为可用空间的 `summaryRatio`（默认 0.1，至少 256，不超过摘要模型的输出上限，也不超过它的窗口减去输入预算）；被截断时要求压短重试一次。摘要默认使用运行的模型，可以用 `model` 指定，分块按两个模型中较小的窗口计算。
- 增量压缩：保留上一次的摘要和它覆盖到的位置，再压缩时只把新切出的消息并进已有摘要；会话的一轮从带入的摘要接着合并；单次摘要请求不超过窗口的一半，超长时分批；两次压缩之间摘要不变，缓存前缀保持稳定；同一时刻只做一次摘要，上一次还没结束时不再发起。
- 连续失败 3 次后冷却 60 秒，冷却期间在尾部加一条提示。

工具自身的输入安全（例如 shell 工具的危险命令黑名单）由工具的 `validate` 负责，引擎在流水线的 d 环节强制执行。

---

## 12. 应用接入

### 12.1 应用负责什么

| 职责 | 内容 |
|---|---|
| 配置与选择 | MCP 服务器配置与预连接列表、插件的安装与启用、skill 目录、凭据存储、模型价格表；决定每个 Agent 用哪些能力 |
| 组装 | 把 agent 定义数据解析成 `Agent`；把会话或业务数据组装成任务（含业务上下文）；选择执行环境，指派模型 |
| 实现 | 审批（`Approver`）、凭据库（`Vault`）、授权存储 |
| 投影 | 订阅运行事件：写会话消息、渲染界面、更新业务数据 |
| 编排与调度 | 多轮对话；多次运行的业务编排；后台任务的优先级与日配额；运行中收到新消息时走 `steer` 还是 `abort`；重跑策略；处理 `engine.interrupted()` 返回的中断运行 |

### 12.2 装配示例

```ts
const plugins = await Promise.all(enabledPluginDirs.map(parsePlugin))
const hooks = adaptHooks(plugins.flatMap(p => p.hooks))

const engine = createEngine({
  services: {
    models: modelHub({ providers, default: defaultModel, concurrency, breaker, pricing }),
    hosts: [mcpHost({ breaker, preconnect: enabledServers }), hookRunner()],   // skill 宿主与委托调度总是带着
    archive: sqliteArchive({ file }), vault, clock,
  },
})

const interactive = engine.environment({
  name: 'interactive',
  principal: { reachable: true, approver: uiApprover },
  notice: [orgGuidelines, ...hooks.notice],
  permissions: [workspaceSandbox({ sensitive, granted }), riskApproval({ mode: 'ask-high' }), ...hooks.permissions],
  guards: hooks.guards,
  checks: [...hooks.checks, groundingCheck({ mode: 'annotate' })],
})

const background = engine.environment({
  name: 'background',
  principal: { reachable: false },
  notice: [orgGuidelines],
  permissions: [workspaceSandbox({ sensitive })],
})
```

Agent 和任务的定义见 §4.7。

### 12.3 交互与后台

两种场景共用同一个引擎，差异全部来自业务对象：

| | 交互 | 后台 |
|---|---|---|
| 执行环境 | 委托人联系得上，有审批 | 委托人联系不上 |
| 能力 | `ask_user`、`propose` 可用 | `ask_user`、`propose` 在准备环节被排除 |
| 兜底交付 | 说明进展和卡点，以一个具体问题结尾 | 报告进展和卡点 |
| 结果处理 | 投影成对话视图；`RunResult.intent` 决定渲染完成摘要、选项还是提议；收到 `delivered` 时结束"核对中" | 在业务事务里提交，并核对业务版本；被引用的运行要 `pin` |

**转交给另一个 Agent**：引擎不提供运行中途换 Agent（I14）。业务需要"这件事交给另一个岗位"时：

1. 给 Agent 一个自定义意图工具，例如 `handoff`，`semantics.intent = { kind: 'complete', code: 'handoff' }`，参数写目标岗位（枚举）和交接说明；
2. 模型调用它时要同时写一段给用户的话（例如"已为你转给劳动仲裁专员"），这一步照常经过交付验收，运行以 `completed` / `handoff` 结束；
3. 应用读 `RunResult.intent.input` 里的目标，用目标 Agent 开会话的下一轮。会话不限制每一轮用哪个 Agent，前文与副作用台账照常带入。

### 12.4 界面隔离

- 引擎只产出持久事件和瞬时通知，应用把它们投影成视图事件发给渲染端。
- 渲染端只认识视图类型，看不到 message、tool_use 这类模型层概念。
- 模型不输出排版协议；"完成、提问、受阻、提议"都用意图工具表达，由渲染端决定怎么画。
- 最终文本在 `delivered` 之前是暂定的。

---

## 13. 测试体系（`testing/`）

测试工具从子路径 `agent-engine/testing` 导入，不在包入口里（§14）。

| 工具 | 用途 |
|---|---|
| `FakeModel` / `FakeTool` / `FakeClock` / `FakeMcpServer` | 用脚本模拟模型、工具、时间和 MCP 服务器，可以注入延迟、错误、截断、超时、断连 |
| `runToEnd`、`replay(archive, runId, mode)` | 跑完一次运行，返回结果和收到的事件（`run_ended` 写不进去时事件里没有它）；按严格或回归方式重放 |
| `assertInvariants(events)` | 检查能从单个运行的日志判断的不变量：I1、I2、I4–I7、I9–I11、I13–I16（I10 用严格重放）。I3、I8、I12 只看单个运行的日志判断不了，分别由组装时的前缀复核、`ctx.callModel` 作为调用模型的唯一入口、发起子运行时的检查保证，并由属性测试覆盖 |
| `conformance.*` | 每类组件的一致性测试：`guard`、`memory`、`exposure`、`check`、`permission`；记忆的用例覆盖压缩触发线以上的样本（`trigger` 可配置），检查成对、任务输入不变、触发线以下不丢消息 |
| `archiveStoreContract(store)` | 存储的契约测试，内存实现和 SQLite 实现都必须通过；包括未结束的运行能被查询到 |
| `chaos(engine)` | 故障注入：模型 5xx 与超时（超时走模型库真实的计时器，可传 `clock`）、MCP 断连、hook 超时、存储写失败（含 blob） |

| 层 | 测什么 |
|---|---|
| 定义 | 各定义函数的校验与冲突报错；五类指纹的稳定性 |
| 核心 | 流程状态机、视图布局、观察、判定的表驱动测试 |
| 交付 | 输出校验退回与自修上限；拦截退回与次数上限；兜底三级退化；`delivered` 的时机 |
| 不变量 | 属性测试：随机组合并发、超时、取消、压缩、守卫告知与封路、子运行、熔断、交付退回；被封住的调用从未执行 |
| 组件 | 每个守卫、每项验收的"触发 / 不触发"；干预前后工具列表和前缀哈希不变；守卫的运行级场景矩阵（docs/guard-mechanism.md §6） |
| 稳定性 | 熔断状态迁移；全局与执行环境的并发排队；副作用工具不重做；启动时补齐中断运行的结尾，并能以它的运行记录开启新运行 |
| 适配器 | 各厂商冒烟测试；Google 对 user 之后的 system 消息的处理；Anthropic 开启 thinking 后带签名回放续做工具调用 |
| 能力 | MCP 准备超时与排除；同类合并；工具名冲突；委托人联系不上时的排除；`INTENT_NOT_ALONE` |
| 回归 | 黄金日志回放；新组件用旧日志离线回放 |
| 观测 | Trace 投影的时间字段完整；导出器的转换正确；诊断日志不含凭据 |

---

## 14. 目录与依赖

```
src/
  index.ts       包入口 agent-engine：应用 API + 标准组件 + 不依赖外部库的适配器 + 带默认组件的 createEngine
  api.ts         应用 API：业务对象与契约、定义函数、平台服务、引擎装配、读运行日志的投影与重放
  sdk.ts         组件作者 API agent-engine/sdk：应用 API + 实现组件、适配器、运行档案用的核心函数与平台机制
  testing.ts     测试工具 agent-engine/testing
  contracts/     业务对象与事件契约；全部组件接口；MCP 与 hook 端口
  core/          纯函数，按领域分组
    run/           流程状态机、视图布局、估算器、种子随机数
    supervision/   观察（事实）、判定、纠偏消息、预算守卫、错误类别、监督统计
    log/           投影、trace、复盘、不变量、重放、事件升级、脱敏
    definition/    定义校验、指纹、冻结、稳定哈希、组件返回值校验
  executor/      各环节的效果：compose/（组装）、act/（工具流水线与权限）、评估、交付、组件调用
  services/      引擎持有、跨运行共享的机制：模型库、准入、熔断；hosts/（MCP 连接池、skill、委托、hook）；
                 进程内的默认实现（系统时钟、内存档案）
  engine/        装配根与回归重放；run/（运行驱动、受理、准备、取消与截止、子运行、订阅与通知、结果、运行上下文、血缘）
  stdlib/        标准组件，按槽位分组；claude-code/ 放 Claude Code 格式的解析与 hook 适配
  adapters/      依赖外部库或外部进程的端口实现：ai-sdk、sqlite、mcp-stdio、mcp-http、hook-process、console-logger；
                 mcp-connect 按传输方式分派，第一次连接时才加载 MCP 适配器
  testing/       测试替身、运行与断言、一致性测试、故障注入、存储契约测试
test/
  arch/          依赖方向、项目文档与仓库配置的一致性
  integration/   引擎级测试，按主题分组：lifecycle、supervision、mcp、components
examples/        按应用的写法使用包名（agent-engine、agent-engine/testing），自带 tsconfig；
  legal-consult/   律所劳动争议咨询平台：覆盖每一类组件的完整示例
```

单元测试与源文件同目录（`<名称>.test.ts`）；只被测试使用的构造放在 `*.fixture.ts`，构建和覆盖率都排除。

**依赖方向**：`contracts ← core ← executor ← engine`；`services` 依赖 `core` 与 `contracts`，只被 `engine` 和入口使用；`stdlib/`、`adapters/`、`testing/` 只经 `sdk.ts` 取用引擎能力；包入口不带测试工具，也不静态加载依赖外部库的适配器。精确的规则只写在 `eslint.config.js` 的依赖方向段并由 lint 强制，`test/arch/boundaries.test.ts` 锁定行为；其他文档不再另抄依赖表。

**放 `services/` 还是 `adapters/`**：依赖外部库或外部进程（含标准输出）的端口实现放 `adapters/`；引擎自带、在进程内就能完成的默认实现（系统时钟、内存档案）放 `services/`，因为 services 自己的工厂也拿它们作默认值。

**包的子路径**：

| 子路径 | 内容 | 另外安装 |
|---|---|---|
| `agent-engine` | 应用 API、标准组件、`createEngine`、`mcpHost`（第一次连接时才加载 MCP 适配器）、`hookRunner`、`consoleLogger` | 用 MCP 时装 `@modelcontextprotocol/sdk` |
| `agent-engine/sdk` | 组件作者 API | — |
| `agent-engine/testing` | 测试工具（§13） | — |
| `agent-engine/adapters/ai-sdk` | `aiSdkProvider` | `ai` |
| `agent-engine/adapters/sqlite` | `sqliteArchive` | `better-sqlite3` |
| `agent-engine/adapters/mcp-stdio`、`agent-engine/adapters/mcp-http` | `stdioConnect`、`httpConnect` | `@modelcontextprotocol/sdk` |

`ai`、`@modelcontextprotocol/sdk`、`better-sqlite3` 都是可选的 peer 依赖：应用和引擎用同一份，模型实例和连接对象不会因为装了两份而对不上。

整个包不 import `electron`、应用代码和界面代码，可以在主进程、独立工作进程、命令行脚本和 vitest 中运行。
