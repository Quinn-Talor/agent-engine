# Agent 引擎落地方案

> 依据：[`docs/agent-engine-design.md`](agent-engine-design.md)（v1.2）。
> 方式：按 k-vibe lite 逐个 feature 实施；每个 feature 先生成编码规格（`vibe/features/<feature>/<feature>.md`），通过门禁后再按 TDD 编码。

---

## 1. 目标与范围

| 项 | 内容 |
|---|---|
| 目标 | 把设计文档实现为 TypeScript 库 `agent-engine`，应用（例如 Talor）可以直接引入 |
| 范围 | 设计文档 §1–§11、§13、§14 的全部内容 |
| 不做 | 应用侧接入（会话、业务 Agent、界面投影，属于应用仓库）；续跑（设计已删除）；发布到 npm |

---

## 2. 落地决策

设计文档没有写死、落地时必须定下来的事项：

| # | 事项 | 决定 | 理由 |
|---|---|---|---|
| D1 | 语言与模块 | TypeScript，ESM，`module` / `moduleResolution` 为 `NodeNext`，相对导入带 `.js` 后缀；Node ≥ 22 | 引擎要能在主进程、独立进程、命令行脚本中不经打包直接运行；Node 下限与 Talor 一致 |
| D2 | 模型接入 | 引擎只依赖 AI SDK 核心包 `ai`；厂商的模型实例由应用创建后交给适配器 | 厂商选择属于配置与选择，归应用；reasoning 参数通过 `providerOptions` 传入，不需要 `@ai-sdk/*` 厂商包 |
| D3 | MCP 协议 | 官方 `@modelcontextprotocol/sdk` 的 `Client` 与 stdio / Streamable HTTP 传输 | 协议由官方维护；Talor 的自研传输依赖 Talor 内部模块，无法直接复用 |
| D4 | SQLite | `better-sqlite3` 为 `peerDependency`（`^12 \|\| ^13`）；开发时安装 `^12.8.0`，本机 Node 26 编译失败时改装 `^13` | 原生模块的版本由宿主决定（Talor 需按 Electron ABI 重建） |
| D5 | 错误信封标记 | `__agent_error` | 引擎是独立仓库；Talor 接入层负责与 `__talor_error` 互相映射 |
| D6 | 敏感路径 | `workspaceSandbox` 内置敏感路径黑名单，不可删除；配置 `sensitive` 只能追加 | 敏感路径泄漏等于账号失控，不属于可配置范围 |
| D7 | 观测导出 | 导出器只把运行事件转换成 OpenTelemetry span、Langfuse observation 的数据结构，发送函数由应用注入 | 不为可选功能引入外部追踪 SDK |
| D8 | 测试替身与属性测试 | 自写 `FakeModel`、`FakeTool`、`FakeClock`、`FakeMcpServer`；属性测试用固定种子的自写随机组合；AI SDK 适配器测试用 `ai/test` 的模拟模型 | 不为测试引入额外依赖；适配器测试覆盖 SDK 的真实调用路径 |
| D9 | 门禁基线 | 不在项目仓库提交。用会话临时目录里的影子仓库（`GIT_DIR=<scratchpad>/ckpt.git`，`GIT_WORK_TREE=` 项目根目录）做 feature 检查点：每个 feature 交付后在影子仓库提交一次，`scope-lock`、`coverage` 以影子仓库的上一个检查点为基线 | 遵守"只在用户要求时提交"；两道门禁仍能按单个 feature 判定 |
| D10 | 公开入口分两层 | `src/api.ts`：除标准组件外的公开 API（定义函数、核心辅助函数、投影、类型）；`src/index.ts`：重新导出 `api.ts`、标准组件、适配器，并提供带默认组件的 `createEngine` | 设计 §14 规定 `engine/` 不能依赖 `stdlib/`，而引擎的默认记忆、默认监督、Agent 的默认交付物与工具呈现都是标准组件；默认值只能在最外层装配。`stdlib/`、`adapters/`、`testing/` 只 import `api.ts` 和 `contracts/`，没有循环依赖 |
| D11 | 消息类型 | `contracts/` 自定义 `ModelMessage` 及各类 part，结构与 AI SDK 的消息兼容；由 AI SDK 适配器做转换 | `contracts/` 只允许依赖 `zod`（设计 §14） |
| D12 | 组件取用宿主 | `ComponentCtx` 新增 `host<T>(kind)`（与 `PrepareCtx.host` 相同）；`record(name, fn, opts?)` 新增可选 `opts.kind: 'record' \| 'hook'` | `adaptHooks` 产出的须知、权限、规定、验收在执行时要经 `hookRunner` 运行 hook，并记为 `external_call` 的 `kind: 'hook'`（设计 §6.2、§8.3）；设计的 `ComponentCtx` 没有取宿主的途径。两处都是新增可选字段，符合契约"只增不改"（§4.6） |
| D14 | 组件配置进入指纹 | `Component`、`Capability` 新增可选 `config?: JsonValue`：组件工厂把可序列化的参数放进去；函数类参数不进入 | 设计 §6.4 要求指纹包含组件的"配置哈希"，设计的 `Component` 只有 id、版本、模式，没有配置的来源。新增可选字段，符合"只增不改" |
| D13 | 交付默认值的解析 | `defineAgent` 不填默认值；受理时按"任务的交付物 > Agent 的交付物 > 引擎装配的默认交付物"解析；工具呈现同理。指纹中缺省项记为 `default` | 配合 D10；Agent 定义保持纯数据 |
| D15 | 能力准备时可读任务 history | `PrepareCtx` 新增可选只读 `history`（任务的 history）；能力仍看不到运行记录 | 设计 §8.3 要求 skill 宿主识别"history 里已激活过的 skill"，设计的 `PrepareCtx` 没有取得途径；新增可选字段，符合"只增不改" |

---

## 3. 工程基线

| 包 | 版本 | 类型 | 用途 |
|---|---|---|---|
| typescript | ^6.0.3 | dev | 类型检查与构建（与 Talor 一致） |
| vitest、@vitest/coverage-v8 | ^4.1.5 | dev | 测试与覆盖率 |
| eslint、@eslint/js、typescript-eslint、eslint-config-prettier、globals | ^10.2.1、^10.0.1、^8.59.1、^10.1.8、^17.5.0 | dev | Lint，含依赖方向规则（与 Talor 一致） |
| prettier | ^3.8.3 | dev | 格式化（无分号、单引号、尾逗号、行宽 100，与 Talor 一致） |
| @types/node | ^22.13.10 | dev | Node 类型 |
| zod | ^4.3.6 | 运行时 | 工具输入 schema、结构化交付 schema（设计 §8.2、§9.8） |
| ai | ^7.0.3 | 运行时 | 只在 `adapters/ai-sdk` 中 import |
| @modelcontextprotocol/sdk | ^1.32.2 | 运行时 | 只在 `adapters/mcp-*` 中 import |
| better-sqlite3、@types/better-sqlite3 | ^12.8.0、^7.6.13 | peer + dev | 只在 `adapters/sqlite` 中 import |

每个依赖在引入它的 feature 的 §B.5.3 中声明，在该 feature 开始编码时安装，不提前安装。

| 命令 | 内容 |
|---|---|
| 测试 | `npm test` → `vitest run` |
| 覆盖率 | `npm run coverage` → `vitest run --coverage`，lcov 输出到 `coverage/lcov.info` |
| 类型检查 | `npm run typecheck` → `tsc --noEmit` |
| Lint | `npm run lint` → `eslint .` |
| Format | `npm run format` → `prettier --write .` |
| 构建 | `npm run build` → `tsc -p tsconfig.build.json` |

---

## 4. 目录

仓库根目录即包根目录，`src/` 对应设计 §14 的 `src/agent-engine/`：

```
src/
  api.ts         公开 API（不含标准组件）
  index.ts       包入口：api.ts + 标准组件 + 适配器 + 带默认组件的 createEngine
  contracts/     业务对象与事件契约；全部组件接口；错误码
  core/          纯函数：流程状态机、视图布局、观察、判定、不变量、输入哈希、指纹、估算器
  executor/      执行器：受理、准备、组装、推理、行动、评估、交付、结束、取消、限额
  services/      平台服务：模型库、熔断、准入、能力宿主、运行档案
  engine/        装配根：createEngine、执行环境、运行句柄、健康状态
  stdlib/        标准组件
  adapters/      ai-sdk、sqlite、mcp-stdio、mcp-http、hook-process、console-logger
  testing/       测试替身、回放、不变量断言、一致性测试、故障注入
```

| 目录 | 允许 import |
|---|---|
| `contracts/` | `zod` |
| `core/` | `contracts/`、`node:crypto` |
| `executor/` | `core/`、`contracts/` |
| `services/` | `contracts/`、`core/`（只用哈希与指纹） |
| `engine/` | `executor/`、`services/`、`core/`、`contracts/` |
| `api.ts` | `engine/`、`services/`（平台服务的工厂，设计 §12.2）、`core/`、`contracts/` |
| `stdlib/`、`testing/` | `api.ts`、`contracts/`、`node:*` |
| `adapters/` | `api.ts`、`contracts/`、`node:*`，以及各自对应的那一个外部库 |
| `index.ts` | 全部 |

规则由 eslint `no-restricted-imports` 强制。`services/` 允许用 `core/` 的哈希函数，是对设计 §14 的细化：MCP 连接池按服务器规格的指纹复用连接（§8.3），指纹算法只能有一份。

---

## 5. Feature 拆分

每个 feature 不超过 5 个 TASK，符合 lite 的适用范围。执行器的各环节先作为独立模块实现并测试，最后由运行驱动串起来；默认组件在运行驱动之前完成。这样每个 feature 交付时都是完整功能，没有桩代码。

| # | Feature | 内容 | 设计章节 | 依赖 | TASK |
|---|---|---|---|---|---|
| F0 | 工程基线与项目规范 | 工具链配置；依赖方向 lint 规则；`vibe/project/` 的 overview、standards、patterns；冒烟测试 | §14 | — | 3 |
| F1 | 契约与定义 | `contracts/` 全部类型、错误码；`defineAgent`、`defineTask` 的校验；输入哈希；五类指纹 | §1、§2、§4.2、§6.4、§9 | F0 | 4 |
| F2 | 核心纯函数 | 流程状态机（`initial`、`apply`、`nextStage`）；视图布局；观察；判定（来源顺序、合并、守卫）；估算器；不变量检查 | §3、§6.1、§7、§8.6 | F1 | 5 |
| F3 | 运行日志 | 内存运行档案（事件、blob、查询、pin、保留）；脱敏；升级器；投影（RunState、Transcript、Observation、Deliveries、Usage、Trace、SideEffects、Corpus、RunSummary）；`archiveStoreContract` | §6.2、§6.3、§8.5 | F1、F2 | 5 |
| F4 | 平台服务 | 熔断器；模型库（解析、并发、熔断、价格）；准入；`Logger` 与控制台适配器；`FakeModel`、`FakeClock` | §1.2、§5.2、§5.3、§6.6、§8.1 | F1 | 4 |
| F5 | 行动环节 | 工具流水线 a–h；权限组合与审批（含等待上限）；副作用与幂等键；意图工具与 `INTENT_NOT_ALONE`；工具并发与 `exclusive`；`FakeTool` | §3.7、§5.4、§8.2、§9.7、§9.10 | F2 | 5 |
| F6 | 交付环节 | 正常路径（输出校验、拦截、定稿、标注）；兜底路径三级退化；`text()`、`structured()` 与 submit；`standardFallback()` | §3.11、§8.4、§9.8、§9.9 | F2、F4 | 4 |
| F7 | 组装与评估环节 | 组装（记忆、工具呈现、布局、提示与引导追加、超限检查）；评估（指标、反思并行、超时、影子模式、监督开销上限、判定） | §3.5、§3.8–§3.10、§5.5 | F2 | 4 |
| F8 | 标准监督 | `standardIndicators()`；`ladderCorrector()`；`modelDiagnoser()`；`SupervisionStats` 投影 | §10.1–§10.5、§10.7 | F7 | 5 |
| F9 | 记忆、呈现与基础能力 | `compactingMemory()`；`searchExposure()`；`tool()`、`tools()`、`bundle()`、`planning()`（含 `progress` 指标）、`intents()` | §4.2、§9.2、§9.3、§11 | F7 | 4 |
| F10 | 运行驱动与引擎装配 | `createEngine`、执行环境、运行句柄（`subscribe`、`steer`、`abort`）；受理、准备、推理、结束；取消树；子运行规则与 `ctx.spawn`；健康状态；中断补齐（只依赖档案端口）；`api.ts`、`index.ts` 默认装配 | §1、§2、§3.3–§3.6、§3.12、§3.14、§6.1、§8.3 子运行规则 | F3–F9 | 5 |
| F11 | skill 与委托 | `skillHost`、`skill()`、`parseSkill()`；`delegationHost`、`subagent()` | §4.2、§8.3 | F10 | 3 |
| F12 | 验收、权限组件与复盘 | `grounding`、`groundingCheck()`；`completionReview()`；`workspaceSandbox()`；`riskApproval()`；`RunRetrospective` 投影与 `retrospect.brief` | §10.6、§10.8、§11 | F10 | 5 |
| F13 | MCP | MCP 连接池（复用、熔断、预连接、健康通知）；`mcp(spec)`；stdio、HTTP 传输适配器；`parseMcpConfig()`；`FakeMcpServer` | §4.2、§5.2、§8.3 | F10 | 5 |
| F14 | hook 与插件 | `hookRunner` 与 hook 进程适配器；`adaptHooks()`；`parsePlugin()` | §4.2、§9.10 | F11、F13 | 3 |
| F15 | 持久化、观测与回放 | SQLite 运行档案；在 SQLite 档案上验证中断补齐（实现在 F10）；`otelExporter`、`langfuseExporter`；严格重放与回归重放 | §3.12、§6.5、§6.6、§8.5 | F10 | 5 |
| F16 | AI SDK 适配器 | 单步调用与流式增量；重试与错误分类；reasoning 参数；消息规整与推理回放；工具选择、缓存断点、用量归一 | §8.1 | F4 | 5 |
| F17 | 端到端与韧性 | 交互、后台、中断后接着做三个端到端场景；`chaos` 故障注入；不变量属性测试；组件一致性测试 `conformance`；README | §12、§13 | F11–F16 | 5 |

```
F0 → F1 ─┬→ F2 ─┬→ F3 ──────────────────┐
         │      ├→ F5 ──────────────────┤
         │      ├→ F6 ←─ F4             │
         │      └→ F7 ─┬→ F8 ───────────┤
         └→ F4         └→ F9 ───────────┴→ F10 ─┬→ F11 ─┐
                                                 ├→ F12  ├→ F14
                                                 ├→ F13 ─┘
                                                 └→ F15
              F4 ──────────────────────────────→ F16
                                       F11–F16 → F17
```

---

## 6. 质量门禁

| 阶段 | 门禁 |
|---|---|
| 编码规格生成后 | `vibe-check.sh` 的 `ambiguity`、`pending`、`cite-lines`、`ac-quota`、`fields lite-s0`、`lite-residuals` 全部通过 |
| 每个 TASK | 先写失败测试，再实现；Format、Lint、类型检查零错误；本 TASK 测试与全量回归通过 |
| feature 交付 | 变更行覆盖率 ≥ 80%；`scope-lock` 通过；§D.4 九项交付检查全部通过；影子仓库提交检查点（D9） |

---

## 7. 设计到 feature 的追溯

| 设计章节 | feature |
|---|---|
| §0 定位与原则 | 全部（写进 `vibe/project/standards.md`） |
| §1 业务对象 | F1、F10 |
| §2 对外接口 | F1、F10 |
| §3 执行流程 | F2、F5、F6、F7、F10 |
| §4 扩展架构 | F1、F9、F11、F13、F14 |
| §5 稳定性设计 | F4（熔断、准入）、F5（副作用与幂等）、F7（影子模式）、F13（MCP 熔断）、F15（中断补齐） |
| §6 实现机制 | F2、F3、F15 |
| §7 不变量 | F2（检查函数）、F17（属性测试） |
| §8 内置部件 | F4、F5、F6、F10、F11、F13、F15、F16 |
| §9 组件契约 | F1（类型）、F5–F9、F12、F14（实现） |
| §10 标准监督与验收 | F8、F12 |
| §11 标准组件库 | F6、F8、F9、F11–F15 |
| §12 应用接入 | F17 |
| §13 测试体系 | F3、F4、F5、F13、F15、F17 |
| §14 目录与依赖 | F0 |

---

## 8. 风险

| 风险 | 应对 |
|---|---|
| Node 26 下 `better-sqlite3` 没有预编译包，需要本地编译 | 只在 F15 安装；`^12.8.0` 编译失败时改装 `^13`；仍失败则暂停 F15 并报告 |
| AI SDK v7、MCP SDK 的具体 API 以安装后的类型声明为准 | F13、F16 编码前先读安装包里的类型声明，规格里引用实际文件和行号 |
| 范围大（18 个 feature） | 严格按依赖顺序推进；门禁全部通过才进入下一个 feature；超出范围的内容写入 DEFERRED |

---

## 9. 审查记录

对照设计文档全文审查初版方案，发现并已修正：

| # | 问题 | 修正 |
|---|---|---|
| 1 | 设计 §14 规定 `engine/` 不能依赖 `stdlib/`，但引擎和 Agent 的默认组件都是标准组件 | D10、D13：默认值在包入口装配 |
| 2 | `contracts/` 只能依赖 `zod`，设计却直接使用 AI SDK 的 `ModelMessage` | D11：自定义消息类型 |
| 3 | hook 适配出的组件在执行时取不到 `hookRunner` | D12：`ComponentCtx` 新增 `host`，`record` 新增 `kind` |
| 4 | 初版按 feature 在项目仓库提交，违背"只在用户要求时提交" | D9：影子仓库做检查点 |
| 5 | 初版"执行器与模型库"一个 feature 含受理到结束全部环节，5 个 TASK 装不下；先写驱动会让后续环节以桩代码存在 | 各环节先独立实现，默认组件先于驱动完成，驱动放在 F10 |
| 6 | 初版 `parsePlugin` 排在 `parseMcpConfig`、`parseSkill` 之前，依赖顺序颠倒 | `parsePlugin` 移到 F14，排在 F11、F13 之后 |
| 7 | 初版遗漏 `standardFallback`、`retrospect.brief`、`SupervisionStats`、`RunRetrospective`、回放、`conformance`、`chaos` | 分别落到 F6、F12、F8、F12、F15、F17、F17 |
| 8 | 属性测试若用现成库需新增依赖 | D8：固定种子的自写随机组合 |
| 9 | `services/` 的 MCP 连接池需要指纹算法，设计依赖表不允许 `services/` 依赖 `core/` | 第 4 节：允许 `services/` 使用 `core/` 的哈希与指纹 |
