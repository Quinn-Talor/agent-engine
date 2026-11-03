# 示例：律所劳动争议咨询平台

一家律所用 agent-engine 搭的初步法律咨询：劳动者问欠薪、辞职、补偿，律师 agent 查档案、检索法规、委托研究员查类案、计算补偿，必要时发律师函，最后交一份结构化的法律意见书。

示例覆盖引擎的每一类组件，大部分是自定义的，演示怎么按业务需要定制。案情、案例虚构，法规为节选，不构成法律意见。

## 运行

需要 Node.js 22.18 及以上（直接执行 TypeScript）。

```bash
npm run demo:legal
```

只跑一个场景，例如发律师函：

```bash
npm run demo:legal -- letter
```

场景测试（断言每个组件确实生效，并对自定义组件跑一致性测试和回归重放）：

```bash
npx vitest run examples
```

演示用一个脚本化的"律师模型"代替大模型（[lawyer-model.ts](lawyer-model.ts)），不联网、每次结果一样。它像真实模型一样只看请求里的对话做决定，所以审批、守卫、验收退回、兜底这些机制都会真实生效。

## 按业务对象组织

配置放在拥有它的业务对象上：换模型改引擎，改规矩改执行环境，改方法论改 skill，改交付标准改交付物，每次咨询的差异放在任务上。

| 文件                                                           | 业务对象 | 组件（引擎槽位）                                                                                                        | 标准 / 自定义 |
| -------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| [platform.ts](platform.ts)                                     | 引擎     | 模型库（三个模型、价格表）、运行档案、MCP 连接池、hook 执行器、凭据库、诊断日志                                         | 标准          |
|                                                                | 引擎     | 记忆：`compactingMemory`（摘要交给便宜的复核模型）                                                                      | 标准，可配置  |
|                                                                | 引擎     | 引擎守卫：`standardGuards`                                                                                              | 标准          |
| [firm-rules.ts](firm-rules.ts)                                 | 执行环境 | 须知：执业边界（固定）、值班律师（动态）、利益冲突审查（可拦下运行）                                                    | 自定义        |
|                                                                | 执行环境 | 权限：客户授权发函                                                                                                      | 自定义        |
|                                                                | 执行环境 | 审批人：律师复核                                                                                                        | 自定义        |
|                                                                | 执行环境 | 守卫：不得承诺结果（用 `thresholdGuard` 搭）                                                                            | 自定义        |
|                                                                | 执行环境 | 强制验收：意见书必须带免责声明                                                                                          | 自定义        |
| [platform.ts](platform.ts)                                     | 执行环境 | 权限：`workspaceSandbox`、`riskApproval`；上限：预算、并发、审批等待、委托深度                                          | 标准          |
| [hooks/letter-recipient.ts](hooks/letter-recipient.ts)         | 执行环境 | Claude Code 格式的 PreToolUse hook，经 `adaptHooks` 变成权限规则                                                        | 自定义脚本    |
| [tools.ts](tools.ts)                                           | Agent    | 工具：法规检索、补偿计算（带输入校验）、发律师函（有副作用、高风险）                                                    | 自定义        |
| [client-dossier.ts](client-dossier.ts)                         | Agent    | 能力：客户档案，一个能力同时带来工具、能力说明和自己的守卫                                                              | 自定义        |
| [skills/labor-dispute/SKILL.md](skills/labor-dispute/SKILL.md) | Agent    | skill：劳动争议的办案方法，业务专家用 Markdown 维护                                                                     | 自定义内容    |
| [servers/case-law.ts](servers/case-law.ts)                     | Agent    | MCP 服务器：案例库，令牌经凭据库按引用传入                                                                              | 自定义服务器  |
| [platform.ts](platform.ts)                                     | Agent    | 能力：`intents`、`planning`、`bundle`、`tool`、`skill`、`mcp`、`subagent`                                               | 标准          |
| [toolbox.ts](toolbox.ts)                                       | Agent    | 工具呈现：按办案阶段给工具                                                                                              | 自定义        |
| [deliverable.ts](deliverable.ts)                               | Agent    | 交付物：结构化意见书 + 领域校验、引用核对（自定义）、`groundingCheck`、`completionReview`、兜底说明（在标准兜底上改写） | 混合          |
| [domain.ts](domain.ts)                                         | —        | 意见书的 zod 结构、领域校验、法规与档案数据                                                                             | 业务数据      |
| [platform.ts](platform.ts) `consultationTask`                  | 任务     | 输入、工作区、业务上下文、目标、任务守卫、预算、覆盖交付物、归属；多轮时 `consult` 给出会话 id                          | —             |
| [audit.ts](audit.ts)                                           | 应用     | 订阅者：把运行日志翻译成办案记录；另接 `otelExporter`                                                                   | 自定义        |
| [lawyer-model.ts](lawyer-model.ts)                             | 应用     | 模型提供方：脚本化的律师、研究员、复核模型（经 `fakeModel` 的函数回复）                                                 | 演示用        |

## 场景

| 场景                     | 演示                                                                              | 结果                   |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------- |
| `standard`               | skill、计划、档案能力、阶段呈现、能力包、子 agent 经 MCP 查类案、领域校验退回一次 | 完成，补偿 54000 元    |
| `follow-up`              | 散客缺事实先 `ask_user`；补充后作为会话的下一轮接着做，前文由引擎推导             | 等待委托人 → 完成      |
| `conflict`               | 利益冲突审查（须知）拦下咨询                                                      | 停止（notice_blocked） |
| `letter`                 | hook 拒绝没写收件人的律师函；补上后客户授权、风险审批、律师批准，发出             | 完成，发出一封律师函   |
| `letter-without-consent` | 客户没授权，客户授权规则拒绝；意见书改为建议先授权                                | 完成，不发函           |
| `promise`                | 模型承诺胜诉，执行环境守卫告知并纠偏                                              | 完成，意见书不再承诺   |
| `stale-dossier`          | 运行中档案被改，能力自带的守卫先告知、再停止                                      | 停止（stale_dossier）  |
| `quick-answer`           | 任务覆盖交付物为文字；步数用完，按自定义兜底说明给阶段性意见                      | 收尾（max_steps）      |
| `sandbox`                | 想读律所内部材料，工作区沙箱拒绝                                                  | 完成                   |

## 定制要点

- **组件只给意见，不做决定。** 守卫告知或要求终止，验收通过或退回，权限放行、询问或拒绝；"下一步怎么办"由引擎统一判定。组件出错时按类型降级（守卫出错视为没有意见，权限出错按拒绝），不会拖垮运行。
- **组件只能收窄能力。** 工具呈现只能从已准备的工具里挑，权限只能拒绝或要求审批。
- **配置进指纹。** 组件的 `id`、`version`、`config` 进入 Agent、执行环境或引擎的指纹；行为改了就升 `version`，统计和回放按指纹区分。
- **时间、随机数和外部调用走 `ctx`。** 例如值班须知用 `ctx.clock` 取日期，重放时结果一致。
- **自定义组件先跑一致性测试。** `conformance.guard / check / permission / exposure / memory` 会喂各种边界输入；这个示例的两个自定义验收就是被它发现"输出形状不对时会抛错"的。
- **多轮对话用会话**：`start` 时给出会话 id，引擎推导这一轮的前文、跨轮压缩、记下副作用台账；应用只管会话 id。场景测试用 `sessionLogIssues` 复核每一轮的窗口（不变量 I17）。
- **子运行总有时长上限**（不变量 I12）：不超过父运行剩余的时长；父运行和子 agent 都没设时，引擎给 10 分钟。
- **结构化交付没有文字兜底**：收尾会改为停止。需要"做不完也给个答复"的产品（例如快问快答），在任务上把交付物覆盖为文字。

## 换成真实模型

把 [platform.ts](platform.ts) 里的 `fakeModel` 换成适配器即可，其余不变：

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { aiSdkProvider } from 'agent-engine/adapters/ai-sdk'

const provider = aiSdkProvider({
  id: 'counsel',
  models: {
    v1: {
      model: anthropic('claude-sonnet-5-5'),
      vendor: 'anthropic',
      capabilities: { contextLimit: 200_000 },
    },
  },
})
```

需要另外安装 `ai` 和厂商包。完成审查（风险分达到 3 才调用模型）和记忆压缩（前文与运行记录达到可用空间的 75% 才触发）在演示里已经装配，只是脚本化的场景没有触发它们的条件；接真实模型后会按条件生效。
