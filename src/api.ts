// 应用 API（不含标准组件）：业务对象与契约、定义函数、平台服务、引擎装配，以及读运行日志的投影与重放。
// 实现组件或适配器要用的核心函数在 sdk.ts（`agent-engine/sdk`），不在这里，免得内部细节变成对应用的承诺。

export * from './contracts/agent.js'
export * from './contracts/capability.js'
export * from './contracts/common.js'
export * from './contracts/component.js'
export * from './contracts/engine.js'
export * from './contracts/environment.js'
export * from './contracts/errors.js'
export * from './contracts/events.js'
export * from './contracts/mcp.js'
export * from './contracts/model.js'
export * from './contracts/run.js'
export * from './contracts/task.js'
export * from './contracts/tool.js'

export { defineAgent, defineTask } from './core/definition/define.js'

// 读运行日志（设计 §6.3、§6.5）：状态、运行记录、交付记录、副作用、摘要、trace、统计、复盘、重放
export type {
  ActiveBlock,
  EffectiveBudget,
  RunCandidate,
  RunOutcome,
  RunPhase,
  RunSnapshot,
  RunState,
  SourcedIntervention,
  Stage,
  ToolMeta,
  TranscriptEntry,
} from './core/run/state.js'
export {
  buildCorpus,
  deliveries,
  foldState,
  observations,
  qualityOf,
  sideEffects,
  summarize,
  transcriptMessages,
} from './core/log/projections.js'
export type { SideEffect } from './core/log/projections.js'
export { supervisionStats } from './core/supervision/supervision-stats.js'
export type { SupervisionStats } from './core/supervision/supervision-stats.js'
export { retrospective } from './core/log/retrospective.js'
export type { RetrospectiveEntry, RunRetrospective } from './core/log/retrospective.js'
export { buildTrace } from './core/log/trace.js'
export type { TraceNode } from './core/log/trace.js'
export { strictReplay } from './core/log/replay.js'
export type { StrictReplay } from './core/log/replay.js'
export { regressionReplay } from './engine/replay.js'
export type { RegressionInput, RegressionReport } from './engine/replay.js'

// 平台服务
export { memoryArchive } from './services/memory-archive.js'
export { systemClock } from './services/clock.js'
export { modelHub } from './services/model-hub.js'
export type { ModelHubOptions } from './services/model-hub.js'
export { skillHost } from './services/hosts/skill-host.js'
export type { SkillHost, SkillPackage } from './services/hosts/skill-host.js'
export { delegationHost } from './services/hosts/delegation-host.js'
export type { DelegationHost, SubagentSpec } from './services/hosts/delegation-host.js'
export { createMcpHost } from './services/hosts/mcp-host.js'
export type { McpHost, McpLease } from './services/hosts/mcp-host.js'
export { createHookRunner } from './services/hosts/hook-runner.js'
export type { HookResult, HookRunner } from './services/hosts/hook-runner.js'

// 引擎装配（默认组件由调用方给出；带标准组件的 createEngine 在 index.ts，方案 D10）
export { assembleEngine } from './engine/engine.js'
export type { EngineDefaults } from './engine/engine.js'
