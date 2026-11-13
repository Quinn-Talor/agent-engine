# agent-engine

[![npm](https://img.shields.io/npm/v/@talor/agent-engine)](https://www.npmjs.com/package/@talor/agent-engine)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@talor/agent-engine)](package.json)

[English](README.md) | 简体中文

agent-engine 是一个 TypeScript 库，用来可靠地运行 AI agent：应用定义 Agent、组装任务、在执行环境里启动运行，引擎按固定流程把运行跑完，返回结果和完整的、只追加的运行日志。

**承载与使用归引擎，配置与选择归应用。** 引擎不负责用哪些 MCP 服务器、装哪些插件、给哪个 agent 什么能力，也不负责会话的产品层（会话 id、权限、列表）、界面、业务数据和 prompt 内容；会话的上下文（接续、下一轮的窗口、跨轮压缩、副作用台账）归引擎。

- **运行一定会结束**：预算、守卫阈值、有上限的重试和一次兜底交付，让模型、工具和组件的失败有边界、有降级、可恢复。
- **可预测、可重放**：运行日志是唯一的事实来源，状态、运行记录、trace、统计、复盘都是它的投影；运行可以严格重放，也可以换上新组件做回归重放。
- **可扩展、不用改引擎**：流程固定，每个环节开放组件槽位，业务扩展直接插进去。

## 功能

| 方面             | 内容                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 流程             | 组装 → 推理 → 行动（权限、审批、并发执行工具）→ 评估（观察 → 守卫意见 → 判定）→ 交付（输出契约 → 验收 → 兜底）               |
| 能力             | 工具、MCP 服务器（stdio 与 Streamable HTTP）、skill、子 agent、计划，以及意图工具（`ask_user`、`propose`、`report_blocked`） |
| Claude Code 插件 | 加载插件里的 skill、agent、MCP 配置和 hook（`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`Stop` 等）                    |
| 会话             | 多轮对话：接续、跨轮压缩、副作用台账、分叉、预览下一轮的窗口                                                                 |
| 多模态输入       | 任务输入和工具结果里的图片、文件；运行开始前按模型声明的输入模态检查                                                         |
| 监督             | 守卫（封路、连续失败、没有新信息、无声推进、压力）给出纠偏消息和封路，可选模型顾问                                           |
| 交付             | 文本或结构化输出；完成度评审对照实际执行过的操作；引文核查；兜底交付                                                         |
| 权限             | 工作区沙箱、按风险审批、审批人可以当场答复或稍后答复                                                                         |
| 前端             | 把运行转成 AI SDK 的 UI message stream 给 `useChat`，SSE 可续流                                                              |
| 观测             | OpenTelemetry 与 Langfuse 导出，按会话归组；trace、复盘、监督统计都是投影                                                    |
| 持久化           | 内存或 SQLite 运行档案，内容寻址的 blob，保留清理、固定、删除会话                                                            |
| 测试             | 脚本化的模型、工具和 MCP 服务器，故障注入，组件一致性测试集，不变量断言，重放                                                |

## 安装

需要 Node.js 22 及以上，只提供 ESM。

包没有发布到 npm 仓库，从 GitHub 的发布标签安装：

```bash
npm install github:Quinn-Talor/agent-engine#v0.1.1 zod
```

npm 会克隆这个标签，用包里的 `prepare` 脚本构建出 `dist`，所以第一次安装会慢一些。导入时用包名 `@talor/agent-engine`。npm 11 可能提示这个 `prepare` 脚本不在 `allowScripts` 里，构建照常执行。想允许它、消掉提示，在你项目的 `package.json` 里加上这段（`npm approve-scripts` 不支持 git 依赖）：

```json
"allowScripts": { "github:Quinn-Talor/agent-engine": true }
```

想直接用本地代码：先在那份代码里运行 `npm install`（会顺带构建 `dist`），再在你的项目里运行 `npm install <代码目录>`。

引擎依赖 `zod` v4，应用定义 schema 时也用它：大版本相同时 npm 只装一份。其余外部库都是可选的 peer 依赖，用到哪个装哪个：

| 要做的事                                        | 安装                                    | 从哪导入                                                 |
| ----------------------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| 经 [Vercel AI SDK](https://ai-sdk.dev) 调用模型 | `ai` 和厂商包，例如 `@ai-sdk/anthropic` | `@talor/agent-engine/adapters/ai-sdk` 的 `aiSdkProvider` |
| 运行档案存进 SQLite（不装时用内存档案）         | `better-sqlite3`                        | `@talor/agent-engine/adapters/sqlite` 的 `sqliteArchive` |
| 接 MCP 服务器                                   | `@modelcontextprotocol/sdk`             | 包入口的 `mcpHost()`，第一次连接时才加载它               |

包的入口：`@talor/agent-engine`（应用 API、标准组件、`createEngine`）、`@talor/agent-engine/sdk`（实现组件或适配器时用的核心函数）、`@talor/agent-engine/testing`（测试工具），以及上面的适配器。

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
} from '@talor/agent-engine'
import { aiSdkProvider } from '@talor/agent-engine/adapters/ai-sdk'
import { sqliteArchive } from '@talor/agent-engine/adapters/sqlite'

// 1. 引擎：平台服务（模型库、运行档案……）。记忆、监督与交付默认使用标准组件（交付带完成度评审）。
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

// 5. 运行：订阅实时输出，等待结果。
const run = interactive.start(assistant, task)
run.subscribe({
  onNotice: (n) => void (n.t === 'text_delta' && process.stdout.write(n.text)),
  onEvent: (e) => void (e.t === 'tool_finished' && console.log(`\n[工具] ${e.callId}`)),
})
const result = await run.result
console.log(result.status, result.code, result.text, result.intent)
```

`result.status` 是运行的结局：`completed`（交付了结果）、`awaiting_input`（需要委托人回复）、`finalized`（没完成，给出了阶段性交付）、`stopped`、`failed`、`aborted`；`result.code` 说明原因，以意图工具结束时 `result.intent` 带着该调用的参数（例如 `ask_user` 的问题）。

## 会话

每一轮开始时给出会话 id。引擎从会话日志推导这一轮带入的前文（接续、跨轮压缩、副作用台账、上一轮的结局），应用只管会话 id 和界面：

```ts
const first = interactive.start(assistant, ask('公司拖欠我三个月工资'), { session: 'case-1024' })
await first.result // awaiting_input：追问入职时间与月薪

// 委托人的回答是会话的下一轮；任务不再给 history。
const second = interactive.start(assistant, ask('2021 年入职，月薪 12000 元'), {
  session: 'case-1024',
})

// 编辑旧消息或重新生成：从指定的一轮分叉；continues: null 从头开始。
interactive.start(assistant, ask('换个问法'), { session: 'case-1024', continues: first.runId })

await engine.previewWindow({ session: 'case-1024' }) // 下一轮会带入什么，不调用模型
await engine.deleteSession('case-1024') // 整个会话（含子运行）一起删除
```

同一会话一次只跑一轮，第二轮受理失败 `session_busy`（可重试）。运行中的引导用 `run.steer(text)`，取消用 `run.abort()`。进程中断的轮在引擎启动时补齐结尾，下一轮照常接上：中断的轮带着一行结局说明，可能已执行的副作用在台账里。完整方案见 [`docs/session-design.md`](docs/session-design.md)。

## 接到聊天界面

`runToUIMessageStreamResponse` 把运行转成 `useChat` 使用的 AI SDK UI message stream，以 SSE 发出并带事件 id，断线的客户端可以续上：

```ts
import { runToUIMessageStreamResponse } from '@talor/agent-engine/adapters/ai-sdk'

export async function POST(req: Request): Promise<Response> {
  const { id, text } = (await req.json()) as { id: string; text: string }
  const run = interactive.start(
    assistant,
    defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text }] }] }),
    { session: id },
  )
  return runToUIMessageStreamResponse(run, { archive })
}
```

续流、在页面上答复审批见 [`examples/chat-endpoint`](examples/chat-endpoint/README.md)。

## 图片与文件

任务输入可以带图片和文件。运行开始前，引擎按模型声明的输入模态检查，模型接不了的直接拒绝：

```ts
const look = defineTask({
  input: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: '这张发票有什么问题？' },
        { type: 'image', image: await readFile('invoice.png'), mediaType: 'image/png' },
      ],
    },
  ],
})
```

## 观测与效果评估

导出器是运行的订阅者，只产出数据，发送由你提供：

```ts
import { otelExporter } from '@talor/agent-engine'

run.subscribe(otelExporter({ send: (spans) => collector.export(spans) }), { children: true })
```

会话的一轮在 OpenTelemetry 里带 `gen_ai.conversation.id`，在 Langfuse 里带 `sessionId`，外部平台据此按会话归组；没通过的验收会标出来（`agent.pass = false`，Langfuse 的 level 为 `WARNING`）。只导出元数据，不导出提示与答复内容。

效果评估（评审打分、跨运行汇总、实验对比）归应用或观测平台；引擎保证评估要用的事实都在：`retrospective(events)` 给出时间线（守卫信号、干预、审批、模型失败、压缩）、每步的模型尝试次数与工具成败、每次交付里每条验收的结论、副作用、用量与耗时；`buildTrace(events)` 给出时序树。

## 核心概念

| 对象                   | 职责                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| 引擎 `Engine`          | 平台服务（模型库、能力宿主、运行档案、凭据库、时钟、准入）与运行机制（记忆、监督） |
| 执行环境 `Environment` | 在这里工作的所有 agent 必须遵守的规矩：委托人、须知、权限、规定、强制验收、上限    |
| Agent                  | 谁来做：指令、能力、默认交付物、模型偏好                                           |
| 任务 `Task`            | 这次做什么：输入、history（不带会话时）、作业范围、交付物、约束条件、预算          |
| 运行 `Run`             | 一次执行的全过程；日志只追加，是唯一的事实来源                                     |

事实、意见、裁决分开记录，每个裁决都能追溯到来源。

## 组件与适配器

组件填进流程里的槽位，都由应用选择：

| 槽位       | 标准组件                                                                         |
| ---------- | -------------------------------------------------------------------------------- |
| 能力       | `tools`、`tool`、`bundle`、`intents`、`planning`、`skill`、`subagent`、`mcp`     |
| 记忆       | `compactingMemory`                                                               |
| 工具呈现   | `searchExposure`                                                                 |
| 监督       | `standardGuards`、`roadblock`、`thresholdGuard`、`modelAdvisor`、`progressGuard` |
| 交付       | `text`、`structured`、`standardFallback`                                         |
| 验收       | `groundingCheck`、`completionReview`（`createEngine` 默认带完成度评审）          |
| 权限       | `workspaceSandbox`（内置敏感路径黑名单，配置只能追加）、`riskApproval`           |
| 插件       | `parsePlugin`、`parseSkill`、`parseMcpConfig`、`adaptHooks`                      |
| 复盘与观测 | `retrospect.brief`、`otelExporter`、`langfuseExporter`                           |

适配器把外部依赖接到端口上：`aiSdkProvider`（模型）、`sqliteArchive`（运行档案）、`mcpHost`（MCP 连接池，按服务器配置走 stdio 或 Streamable HTTP）、`hookRunner`（hook 进程）、`consoleLogger`（诊断日志）。

## 测试工具

从 `@talor/agent-engine/testing` 导入：

| 工具                                                         | 用途                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `fakeModel`、`fakeTool`、`fakeMcpServer`、`FakeClock`        | 脚本化的模型、工具、MCP 服务器与可控时钟                                |
| `runToEnd(run)`                                              | 跑完一次运行，返回结果和收到的事件                                      |
| `assertInvariants(events)`                                   | 断言运行日志满足引擎的不变量，违规时列出每一条                          |
| `replay(archive, runId, 'strict')`                           | 严格重放档案里的运行；传 `{ mode: 'regression', … }` 用新组件做回归重放 |
| `chaos({ seed, rate, faults, clock })`                       | 包装模型提供方、运行档案、MCP 连接与 hook 执行，按种子注入故障          |
| `conformance.guard / memory / exposure / check / permission` | 组件一致性测试集                                                        |
| `archiveStoreContract(make)`                                 | 任何 `ArchiveStore` 实现都必须通过的契约测试                            |

一致性测试集与契约测试返回用例列表，交给你自己的测试框架：

```ts
import { conformance } from '@talor/agent-engine/testing'

for (const c of conformance.memory(myMemory)) it(c.name, () => c.run())
```

## 示例

- [`examples/legal-consult`](examples/legal-consult/README.md)：一家律所的劳动争议咨询平台，覆盖引擎的每一类组件，多数是自定义的，带九个可运行的场景（`npm run demo:legal`）。
- [`examples/chat-endpoint`](examples/chat-endpoint/README.md)：给 `useChat` 用的聊天端点，带续流和审批。

## 文档

- [`docs/agent-engine-design.md`](docs/agent-engine-design.md)：完整设计（业务对象、执行流程、扩展架构、运行日志、不变量、标准组件库）
- [`docs/session-design.md`](docs/session-design.md)：会话
- [`docs/guard-mechanism.md`](docs/guard-mechanism.md)：守卫
- [`docs/feature-catalog.md`](docs/feature-catalog.md)：功能清单、代码位置与测试对照

## 开发

```bash
npm install
```

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
npm run build
```

依赖方向（`contracts → core → executor / services → engine → api.ts`，`stdlib`、`testing`、`adapters` 只经公开 API 取用引擎能力）由 `eslint.config.js` 强制。提交 PR 前请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
