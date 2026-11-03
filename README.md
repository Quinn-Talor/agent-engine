# agent

agent-engine 是一个 TypeScript 库：应用定义 Agent、组装任务、在执行环境里启动运行，引擎按固定流程把运行可靠地跑完，返回结果和完整的运行日志。

**承载与使用归引擎，配置与选择归应用。** 引擎不负责用哪些 MCP 服务器、装哪些插件、给哪个 agent 什么能力，也不负责会话的产品层（会话 id、权限、列表）、界面、业务数据和 prompt 内容；会话的上下文（接续、窗口、跨轮压缩）归引擎。

- 运行一定会结束：外部依赖和组件的失败有边界、有降级、可恢复。
- 可预测、可重放：运行日志是唯一的事实来源，状态、trace、统计、复盘都从它推导。
- 可扩展：流程固定，只开放各环节里的组件槽位；业务扩展不需要改引擎。

完整设计见 [`docs/agent-engine-design.md`](docs/agent-engine-design.md)，落地方案见 [`docs/implementation-plan.md`](docs/implementation-plan.md)。

## 安装

需要 Node.js 22 及以上。包尚未发布到 npm：在本仓库构建后，用 `npm link` 或本地路径依赖引入。

```bash
npm install
```

```bash
npm run build
```

引擎依赖 `zod` v4，应用定义 schema 时也用它：应用装的版本落在同一个大版本内时，npm 只装一份。其余外部库都是可选的 peer 依赖，用到哪个装哪个，应用和引擎共用同一份：

- 模型经 [Vercel AI SDK](https://ai-sdk.dev) 接入：安装 `ai` 和厂商包（例如 `@ai-sdk/anthropic`），从 `agent-engine/adapters/ai-sdk` 导入 `aiSdkProvider`。
- 持久化的运行档案用 SQLite：安装 `better-sqlite3`，从 `agent-engine/adapters/sqlite` 导入 `sqliteArchive`；不装时引擎使用内存档案。
- 接 MCP 服务器：安装 `@modelcontextprotocol/sdk`；包入口的 `mcpHost()` 第一次连接时才加载它。

包的子路径：`agent-engine`（应用 API、标准组件、`createEngine`）、`agent-engine/sdk`（实现组件或适配器时用的核心函数）、`agent-engine/testing`（测试工具），以及上面的适配器。

## 快速开始

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import {
  createEngine,
  defineAgent,
  defineTask,
  intents,
  modelHub,
  tools,
  type ToolDef,
} from 'agent-engine'
import { aiSdkProvider } from 'agent-engine/adapters/ai-sdk'
import { sqliteArchive } from 'agent-engine/adapters/sqlite'

// 1. 引擎：平台服务（模型库、运行档案……）。记忆、监督与交付默认使用标准组件（交付带完成审查）。
const provider = aiSdkProvider({
  id: 'anthropic',
  models: {
    sonnet: {
      model: anthropic('claude-sonnet-5-5'),
      vendor: 'anthropic',
      capabilities: { contextLimit: 200_000 },
    },
  },
})
const engine = createEngine({
  services: {
    models: modelHub({ providers: [provider], default: 'anthropic:sonnet' }),
    archive: sqliteArchive({ file: 'runs.db' }),
  },
})

// 2. 执行环境：组织的规矩。委托人联系得上时 ask_user、propose 可用。
const interactive = engine.environment({ name: 'interactive', principal: { reachable: true } })

// 3. Agent：谁来做——指令与能力。
const weather: ToolDef = {
  name: 'weather',
  description: '查询城市天气',
  inputSchema: z.object({ city: z.string() }),
  execution: { effect: 'none' },
  async execute(input) {
    const { city } = input as { city: string }
    return `${city}：晴，20 度`
  },
}
const assistant = defineAgent({
  id: 'assistant',
  instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是出行助手' }] }],
  capabilities: [intents(), tools([weather])],
})

// 4. 任务：这次做什么、做到什么程度。
const task = defineTask({
  input: [{ role: 'user', parts: [{ type: 'text', text: '明天去东京要带伞吗？' }] }],
  budget: { maxSteps: 10, maxTotalMs: 120_000 },
})

// 5. 运行：订阅事件做投影，等待结果。
const run = interactive.start(assistant, task)
run.subscribe({
  onNotice: (n) => void (n.t === 'text_delta' && process.stdout.write(n.text)),
  onEvent: (e) => void (e.t === 'tool_finished' && console.log(`\n[工具] ${e.callId}`)),
})
const result = await run.result
console.log(result.status, result.code, result.text, result.intent)
```

`result.status` 是运行的结局：`completed`（交付了结果）、`awaiting_input`（需要委托人回复）、`finalized`（没完成，给出了阶段性交付）、`stopped`、`failed`、`aborted`；`result.code` 说明原因，以意图工具结束时 `result.intent` 带着该调用的参数（例如 `ask_user` 的问题）。

### 多轮对话与接着做

多轮对话用会话：每一轮开始时给出会话 id，引擎从会话日志推导这一轮带入的前文（接续、跨轮压缩、副作用台账、上一轮的结局），应用只管会话 id 和界面（完整方案见 [docs/session-design.md](docs/session-design.md)）：

```ts
const first = environment.start(agent, ask('公司拖欠我工资，能拿回多少？'), {
  session: 'case-1024',
})
await first.result // awaiting_input：律师追问入职时间与月薪

// 委托人的回答是会话的下一轮；任务不再给 history。
const second = environment.start(agent, ask('2021 年入职，月薪 12000 元'), { session: 'case-1024' })

// 编辑旧消息或重新生成：从指定的一轮分叉；continues: null 从头开始。
environment.start(agent, ask('换个问法'), { session: 'case-1024', continues: first.runId })

await engine.previewWindow({ session: 'case-1024' }) // 下一轮会带入什么，不调用模型
await engine.deleteSession('case-1024') // 整个会话（含子运行）一起删除
```

同一会话一次只跑一轮，第二轮受理失败 `session_busy`（可重试）；运行中的追加用 `run.steer(text)`，运行结束后它返回 `false`。进程中断的轮在引擎启动时补齐结尾，下一轮照常接上：中断的轮带着一行结局说明，可能已执行的副作用在台账里。

运行中的引导用 `run.steer(text)`，取消用 `run.abort()`。要同时收到子运行的事件和通知（例如把整棵委托树导出到观测后端），订阅时传 `{ children: true }`，用回调的 `run.runId` 区分是哪次运行。

## 示例

[`examples/legal-consult`](examples/legal-consult/README.md)：一家律所的劳动争议咨询平台，覆盖引擎的每一类组件，多数是自定义的，并带九个可运行的场景（`npm run demo:legal`）。

## 核心概念

| 对象                   | 职责                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| 引擎 `Engine`          | 平台服务（模型库、能力宿主、运行档案、凭据库、时钟、准入）与运行机制（记忆、监督） |
| 执行环境 `Environment` | 在这里工作的所有 agent 必须遵守的规矩：委托人、须知、权限、规定、强制验收、上限    |
| Agent                  | 谁来做：指令、能力、默认交付物、模型偏好                                           |
| 任务 `Task`            | 这次做什么：输入、history（不带会话时）、作业范围、交付物、约束条件、预算          |
| 运行 `Run`             | 一次执行的全过程；日志只追加，是唯一的事实来源                                     |

每一步按固定流程执行：**组装**视图 → **推理** → **行动**（权限、审批、并发执行工具）→ **评估**（观察 → 守卫意见 → 判定，继续时带上纠偏消息）→ **交付**（输出契约 → 验收 → 兜底）。事实、意见、裁决分开记录，每个裁决都能追溯到来源。

## 组件与适配器

组件填进流程里的槽位，都由应用选择：

| 槽位       | 标准组件                                                                         |
| ---------- | -------------------------------------------------------------------------------- |
| 能力       | `tools`、`tool`、`bundle`、`intents`、`planning`、`skill`、`subagent`、`mcp`     |
| 记忆       | `compactingMemory`                                                               |
| 工具呈现   | `searchExposure`                                                                 |
| 监督       | `standardGuards`、`roadblock`、`thresholdGuard`、`modelAdvisor`、`progressGuard` |
| 交付       | `text`、`structured`、`standardFallback`                                         |
| 验收       | `groundingCheck`、`completionReview`（`createEngine` 默认带完成审查）            |
| 权限       | `workspaceSandbox`（内置敏感路径黑名单，配置只能追加）、`riskApproval`           |
| 插件       | `parsePlugin`、`parseSkill`、`parseMcpConfig`、`adaptHooks`                      |
| 复盘与观测 | `retrospect.brief`、`otelExporter`、`langfuseExporter`                           |

适配器把外部依赖接到端口上：`aiSdkProvider`（模型，`agent-engine/adapters/ai-sdk`）、`sqliteArchive`（运行档案，`agent-engine/adapters/sqlite`）、`mcpHost`（MCP 连接池，按服务器配置走 stdio 或 Streamable HTTP）、`hookRunner`（hook 进程）、`consoleLogger`（诊断日志）。

## 测试工具

测试工具从 `agent-engine/testing` 导入，应用和组件作者可以直接使用：

| 工具                                                         | 用途                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `fakeModel`、`fakeTool`、`fakeMcpServer`、`FakeClock`        | 脚本化的模型、工具、MCP 服务器与可控时钟                                                                             |
| `runToEnd(run)`                                              | 跑完一次运行，返回结果和收到的事件（`run_ended` 写不进去时事件里没有它）                                             |
| `assertInvariants(events)`                                   | 断言运行日志满足不变量，违规时列出每一条                                                                             |
| `replay(archive, runId, 'strict')`                           | 严格重放档案里的运行；传 `{ mode: 'regression', … }` 用新组件做回归重放                                              |
| `chaos({ seed, rate, faults, clock })`                       | 包装模型提供方、运行档案、MCP 连接与 hook 执行，按种子注入故障；超时按 `clock` 计时                                  |
| `conformance.guard / memory / exposure / check / permission` | 组件一致性测试集：确定性、只收窄、不破坏成对、返回值形状合法；守卫不能每个健康步都告知；记忆覆盖压缩触发线以上的样本 |
| `archiveStoreContract(make)`                                 | 任何 `ArchiveStore` 实现都必须通过的契约测试                                                                         |

一致性测试集与契约测试返回用例列表，交给你自己的测试框架：

```ts
import { conformance } from 'agent-engine/testing'

for (const c of conformance.memory(myMemory)) it(c.name, () => c.run())
```

## 开发

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run coverage
```

```bash
npm run build
```

依赖方向（`contracts → core → executor / services → engine → api.ts`，`stdlib`、`testing`、`adapters` 只经公开 API 取用引擎能力）由 `eslint.config.js` 强制。工程规范见 [`vibe/project/`](vibe/project/)。

## 许可证

[MIT](LICENSE)
