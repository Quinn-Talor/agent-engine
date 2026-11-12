# agent-engine 功能清单与测试对照

> 梳理时间 2026-11-12，基于提交 `9382578` 加上本次新增的 `test/integration/lifecycle/feature-tour.test.ts`。
> 设计依据见 `docs/agent-engine-design.md`；本文只列"有什么、在哪、怎么验证过"。

## 0. 本次验证结果

| 验证 | 结果 |
|---|---|
| 全量测试 `npm test` | 128 个文件、1741 条全部通过 |
| 示例测试（法律咨询、聊天端点） | 2 个文件、27 条通过 |
| 演示 `npm run demo:legal`（构建后用包入口跑 9 个场景，脚本化模型、不联网） | 9 个场景全部按预期结束 |
| 新增功能全流程测试 `feature-tour.test.ts` | 4 条通过；把 Stop hook 改成总是放行后对应用例失败，断言有效 |
| 类型检查、lint、格式检查 | 通过（修了 lint 会扫进 `.claude/worktrees` 的问题，见 §16） |

真实大模型没有参与：本机没有模型 API key。全部端到端测试用脚本化模型；对真实厂商包的请求体另做过核对（F27、F28）。

## 1. 运行主流程（ReAct 循环）

流程固定：受理 → 准备 → 步循环（① 组装 → ② 推理 → ③ 行动 → ④ 观察 → ⑤ 反思 → ⑥ 判定）→ 交付 → 结束。

| 环节 | 做什么 | 代码 | 测试 |
|---|---|---|---|
| 定义 | `defineAgent` / `defineTask` 校验全部问题后一次报告、算指纹、冻结；图片与文件的形式、类型、大小、个数 | `src/core/definition/define.ts` | `define.test.ts`、`immutability.test.ts` |
| 受理 | 核对指纹、预算不超执行环境上限、解析模型（指派 > 偏好 > 继承 > 默认）、能力与输入模态核对、会话串行 | `src/engine/run/admit.ts`、`session.ts` | `admit.test.ts` |
| 准入 | 执行环境并发上限 + 引擎全局排队、排队超时 | `src/services/admission.ts` | `admission.test.ts` |
| 准备 | 能力 `prepare`（工具、说明、守卫）、须知（静态与动态，可拦下运行）、能力宿主、不可用能力记入 `unavailable` | `src/engine/run/prepare.ts` | `prepare.test.ts`、法律咨询 conflict 场景 |
| ① 组装 | 固定视图布局、缓存断点、记忆压缩、超限丢最早整轮、截图老化、工具呈现 | `src/executor/compose/`、`src/core/run/layout.ts` | `compose*.test.ts`、`layout.test.ts`、feature-tour |
| ② 推理 | 调模型（流式增量）、清洗泄漏的工具调用标记、重复调用 id 去重 | `src/adapters/ai-sdk/` | `ai-sdk-provider.test.ts` |
| ③ 行动 | 工具流水线 a–h（§2），同一步多个调用并发（默认 5） | `src/executor/act/` | `act*.test.ts`、feature-tour |
| ④ 观察 / ⑤ 反思 | 事实提取、守卫意见、纠偏消息、封路 | `src/core/supervision/` | `decide.test.ts`、`guards.test.ts` |
| ⑥ 判定 | 继续 / 完成 / 收尾 / 等待输入 / 停止，单一 `decide` | `src/core/supervision/decide.ts` | `decide.test.ts`、不变量属性测试 |
| 交付 | 输出校验与修复、验收（拦截/标注/影子）、退回后回到步循环、兜底三级退化 | `src/executor/deliver.ts`、`evaluate.ts` | `deliver.test.ts`、`create-engine.test.ts` |
| 结束 | 结局 status/code、用量与费用、`run_ended` | `src/engine/run/run-result.ts` | 各集成测试 |

## 2. 工具流水线

| 环节 | 检查 | 失败时 |
|---|---|---|
| a 查找 | 本步是否可见 | `TOOL_NOT_AVAILABLE`（提示先 `search_tool`） |
| b 封路 | 工具名 + 输入哈希是否被封 | `TOOL_BLOCKED` |
| c 参数校验 | schema 全字段，拼写相近时提示 | `INVALID_INPUT` |
| d 工具自校验 | 工具的 `validate` | 工具给的错误信封 |
| e 权限与审批 | 权限规则组合，必要时等审批或延后答复 | `PERMISSION_DENIED` / `USER_DENIED` / `APPROVAL_PENDING` |
| f 熔断 | 依赖的熔断器 | `TOOL_UNAVAILABLE` |
| g 执行 | 超时、取消、意图工具 | `TOOL_TIMEOUT` / `TOOL_ABORTED` / `TOOL_EXCEPTION` |
| h 规整 | 错误信封、内容块（文本 + 图片）、脱敏、截断、`<tool_output>` 包裹 | — |

代码 `src/executor/act/`；测试 `pipeline.test.ts`、`exec.test.ts`、`act.test.ts`。副作用调用永不自动重做；调用带幂等键；工具里可以调模型（`ctx.callModel`，`tool-model-call.test.ts`）。

## 3. 能力类型

| 能力 | 用法 | 代码 | 端到端验证 |
|---|---|---|---|
| 本地工具 | `tool()`、`tools()`、`bundle()`，zod 或 JSON Schema，副作用类型 | `src/stdlib/capabilities/tools.ts` | 几乎所有集成测试 |
| MCP | `mcp(spec)`：stdio、HTTP，连接池、熔断、工具改名、延迟加载、错误类别 | `mcp.ts`、`src/services/hosts/mcp-host.ts`、`src/adapters/mcp-*` | `create-engine` AC-021/022、`test/integration/mcp/*`（含真实 stdio 进程）、feature-tour |
| skill | `skill(pkg)` + `activate_skill` 工具按需读取完整说明 | `skill.ts`、`skill-host.ts` | `create-engine` AC-012、法律咨询、feature-tour |
| 子 agent 委托 | `subagent(agent)` + 共享的 `delegate` 工具；深度、次数、并发上限；子运行预算继承 | `subagent.ts`、`delegation-host.ts`、`child-runs.ts` | `create-engine` AC-013、法律咨询、feature-tour |
| 规划 | `planning()` 计划工具 + `progressGuard()` | `planning.ts` | `guards.test.ts`、法律咨询 |
| 意图 | `intents()`：`ask_user`、`propose` 结束运行等待委托人 | `intents.ts` | `scenarios.test.ts`、法律咨询 follow-up |
| 工具搜索 | `searchExposure()` + BM25 排序，`search_tool` 按需加载 | `src/stdlib/exposure/` | `tool-search.test.ts`、离线评测 `tool-ranker.eval.test.ts` |

## 4. Claude Code 兼容

| 功能 | 代码 | 端到端验证 |
|---|---|---|
| 插件 `parsePlugin(dir)`：skills/、agents/、.mcp.json、hooks/hooks.json、commands/，`${CLAUDE_PLUGIN_ROOT}` 替换 | `src/stdlib/claude-code/parse-plugin.ts` | **feature-tour（本次新增）** |
| skill 目录 `parseSkill` | `parse-skill.ts` | 法律咨询、feature-tour |
| MCP 配置 `parseMcpConfig` | `parse-mcp-config.ts` | `create-engine`、feature-tour |
| hook 适配 `adaptHooks`：SessionStart/UserPromptSubmit → 须知，PreToolUse → 权限，PostToolUse → 守卫提示，Stop/SubagentStop → 强制验收 | `adapt-hooks.ts`、`hook-runner.ts`、`hook-process.ts` | `create-engine` AC-016、`cancellation.test.ts`、法律咨询 letter、**feature-tour 四种 hook 全部用真实子进程** |

hook 在独立进程组里跑，带超时，取消时结束整个进程组，环境变量只给白名单。

## 5. 交付

| 功能 | 代码 | 测试 |
|---|---|---|
| 输出契约 `text()`、`structured(schema)`（经 `submit` 工具，修复次数上限） | `src/stdlib/delivery/output-contracts.ts` | `create-engine`、法律咨询 |
| 验收：完成审查 `completionReview`、依据核查 `grounding`/`groundingCheck`、hook 的 Stop | `src/stdlib/checks/` | 单测 70 条、法律咨询 |
| 兜底 `standardFallback`：阶段性交付、固定文本、委托人不可达时的说明 | `standard-fallback.ts` | 法律咨询 quick-answer |

## 6. 监督

| 功能 | 代码 | 测试 |
|---|---|---|
| 四级守卫（引擎、执行环境、任务、能力），先告知后终止 | `src/core/supervision/`、`src/stdlib/supervision/` | `guards.test.ts`、法律咨询 promise、stale-dossier |
| 标准守卫：重复调用、连续失败、截断、无进展等 | `standard-guards.ts` | 同上 |
| 封路 `roadblock`：确定性失败后封住同样的调用、变更后解封 | `roadblock.ts` | `unblock-on-change.test.ts`、法律咨询 |
| 计数守卫 `thresholdGuard`、顾问 `modelAdvisor` | `threshold-guard.ts`、`advisor.ts` | 单测、`conformance.test.ts` |
| 委托人引导 `steer`：运行中并入、解除封路 | `src/contracts/run.ts` | `guards.test.ts` AC-043 |
| 监督统计、复盘 | `supervision-stats.ts`、`retrospective.ts`、`retrospect` | 单测、法律咨询 |

## 7. 权限与安全

| 功能 | 代码 | 测试 |
|---|---|---|
| 工作区路径沙箱（内置敏感路径，只能追加） | `workspace-sandbox.ts` | 单测、法律咨询 sandbox |
| 风险审批 `riskApproval`、审批人同步答复或延后答复 | `risk-approval.ts` | `deferred-approval.test.ts`、法律咨询 letter |
| 权限组合：任一拒绝即拒绝，联系不上委托人按拒绝 | `src/executor/act/` | `pipeline.test.ts` |
| 凭据按引用解析、写日志前脱敏、hook 环境变量白名单 | `src/engine/run/`、`hook-process.ts` | 单测、法律咨询（令牌不进日志） |

## 8. 会话与记忆

| 功能 | 代码 | 测试 |
|---|---|---|
| 会话：每轮窗口由日志确定性推导（carry），冻结进 `run_started`，可复核（I17） | `src/core/session/window.ts`、`src/services/session-log.ts` | `session.test.ts`（单元与集成）、属性测试 |
| 副作用台账（含子运行），分叉，预览窗口，删除会话 | 同上、`engine.ts` | 同上 |
| 压缩记忆：轮开始、轮中、超限丢最早整轮 | `compacting-memory.ts`、`compose.ts` | `session.test.ts` AC-014 |
| 中断后接着做：启动补齐、`engine.interrupted()`、开下一轮 | `engine.ts` | `persistence.test.ts`、`scenarios.test.ts` AC-017 |

## 9. 多模态输入

| 功能 | 代码 | 测试 |
|---|---|---|
| 模态归类 `modalityOf`：文本 / 图片 / PDF / 音频 / 视频 | `src/core/run/modality.ts` | `modality.test.ts` |
| 定义期：只收字节、base64、data URL，拒绝网址；大小与个数上限 | `define.ts` | `define.test.ts`、feature-tour |
| 能力 `inputs`，受理时按模态核对 | `admit.ts` | `admit.test.ts`、feature-tour（PDF 被拒） |
| 适配器：文本文件转文字、模型不收的模态换说明、工具结果图片按厂商放置 | `messages.ts` | `messages.test.ts`、feature-tour（AI SDK 请求体） |
| 截图老化 `keepRecentImages` | `layout.ts` | `layout.test.ts`、**feature-tour（引擎级）** |
| 内容 blob 里的媒体只存一份，引用写进 `task.media` | `src/core/log/task-content.ts` | `task-content.test.ts`、`session.test.ts`、档案契约 |
| token 估算：图片按尺寸、PDF 按页、文本按内容 | `media-tokens.ts`、`estimate.ts` | 单测 |

## 10. 模型层

| 功能 | 代码 | 测试 |
|---|---|---|
| 模型库：多提供方、默认模型、按提供方并发、按模型熔断、价格表 | `src/services/model-hub.ts`、`breaker.ts` | 单测 |
| AI SDK 7 适配器：流式、重试、错误分类、推理参数、缓存断点、用量归一、调用参数 | `src/adapters/ai-sdk/` | 122 条单测、`create-engine` AC-019 |
| 系统消息改写、推理签名回放、工具调用元数据回放 | `messages.ts` | `messages.test.ts` |

## 11. 持久化、回放、观测

| 功能 | 代码 | 测试 |
|---|---|---|
| 事件溯源运行日志，先写日志再改状态 | `run-driver.ts` | 不变量属性测试 |
| 档案：内存、SQLite（锁文件保证单实例），保留清理、固定、删除会话 | `memory-archive.ts`、`sqlite-archive.ts` | 档案契约测试（两种档案共用） |
| 严格回放、回归回放 | `src/core/log/replay.ts`、`src/engine/replay.ts` | `replay.test.ts`、法律咨询 |
| trace、OTel、Langfuse 导出 | `trace.ts`、`src/stdlib/observability/` | 单测、法律咨询 |
| 可评估性：trace 带会话与轮次、交付验收节点；导出带会话（OTel `gen_ai.conversation.id`、Langfuse `sessionId`），没通过的验收标出；复盘补上审批、模型失败与重试次数、压缩、每条验收的结论、排队时长 | `trace.ts`、`retrospective.ts`、`src/stdlib/observability/` | 单测、`feature-tour.test.ts` |
| 健康状态：熔断器、准入 | `engine.ts` | `create-engine` |

## 12. 稳定性

预算（步数、时长、输入 token、费用）、取消（运行与 hook 进程一起结束）、组件超时与固定降级、熔断、准入、不变量自检、混沌测试。测试：`cancellation.test.ts`、`component-errors.test.ts`、`chaos.test.ts`、`invariants.property.test.ts`。

## 13. 前端流

`runToUIMessageStream` / `runToUIMessageStreamResponse`：运行转成 AI SDK UI message stream，`useChat` 直接用；支持从头回放与按 `Last-Event-ID` 续流；审批状态体现在工具部件上。代码 `src/adapters/ai-sdk/ui-message-stream.ts`；测试 `ui-message-stream.test.ts`、`examples/chat-endpoint`。

## 14. 测试工具（`@talor/agent-engine/testing`）

`fakeModel`、`fakeTool`、`fakeMcpServer`、`FakeClock`、`runToEnd`、`assertInvariants`、`replay`、`chaos`、`conformance`（组件规约检查）、`archiveStoreContract`（自定义档案的契约测试）、`sessionLogIssues`。

## 15. 端到端验证矩阵

"端到端"指从 `createEngine` 装配、跑完整个运行，不是只测单个模块。

| 流程 | 端到端用例 |
|---|---|
| 多步 ReAct 循环 + 同一步并发调用 | feature-tour；法律咨询 standard（7 步 12 次调用） |
| 本地工具 / MCP / skill / 子 agent | feature-tour；`create-engine`；法律咨询 |
| 插件整包加载（skill、agent、MCP、hook、命令） | feature-tour（本次新增） |
| hook：SessionStart、PreToolUse、PostToolUse、Stop | feature-tour（真实子进程）；`create-engine` AC-016 |
| 审批同步与延后、意图等待委托人 | `deferred-approval.test.ts`、`scenarios.test.ts`、法律咨询 letter、follow-up |
| 守卫、封路、纠偏、兜底 | `guards.test.ts`；法律咨询 promise、stale-dossier、quick-answer |
| 结构化交付与修复、验收退回 | `create-engine`；法律咨询 standard |
| 会话多轮、压缩、中断后接着做、台账 | `session.test.ts`、`persistence.test.ts`、法律咨询 follow-up |
| 多模态：文件转文字、PDF 受理失败、网址拒绝、截图老化 | feature-tour（本次新增） |
| 回放与观测 | 法律咨询；`create-engine` AC-022 |
| 前端流 | `examples/chat-endpoint` |
| 经 AI SDK 适配器的完整运行 | `create-engine` AC-019；feature-tour |

## 16. 本次发现

| 发现 | 处理 |
|---|---|
| `npm run lint` 会扫进 Claude Code 在仓库里建的 worktree（`.claude/worktrees/…`），报 563 个错误，还干扰了 `src` 的类型信息 | 已修：`eslint.config.js` 与 `.prettierignore` 忽略 `.claude/` |
| 插件整包加载、截图老化、文件输入此前没有引擎级端到端用例 | 已补：`feature-tour.test.ts` |
| 顾问 `modelAdvisor` 只有规约测试和单测，没有在完整运行里验证 | 未补 |
| 模型熔断打开时的整条运行路径没有端到端用例（熔断器本身有单测） | 未补 |
| SQLite 档案的保留清理只在档案契约测试里验证，没有经引擎跑 | 未补 |
| 全部端到端测试用脚本化模型，没有用真实大模型跑过 | 需要模型 API key |
| 已知缺口（评审结论，不属于测试问题）：没有执行沙箱、多实例部署、跨会话长期记忆 | 见整体评审 |
| 效果评估（评审打分、分数存储、跨运行汇总、实验对比）不归引擎 | 引擎只提供可评估性，见设计 §0.1；复盘与 trace 已补齐评估要用的事实（§11） |
