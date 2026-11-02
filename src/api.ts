// 公开 API（不含标准组件）。`stdlib/`、`adapters/`、`testing/` 只经这里与 `contracts/` 取用引擎能力（方案 D10）。

export * from './contracts/agent.js'
export * from './contracts/capability.js'
export * from './contracts/common.js'
export * from './contracts/component.js'
export * from './contracts/engine.js'
export * from './contracts/environment.js'
export * from './contracts/errors.js'
export * from './contracts/events.js'
export * from './contracts/model.js'
export * from './contracts/run.js'
export * from './contracts/task.js'
export * from './contracts/tool.js'

export { canonicalJson, hashOf, inputHash, sha256Hex } from './core/definition/hash.js'
export {
  agentFingerprint,
  componentIdentity,
  engineFingerprint,
  environmentFingerprint,
  taskFingerprint,
} from './core/definition/fingerprint.js'
export type { ComponentIdentity } from './core/definition/fingerprint.js'
export { defineAgent, defineTask } from './core/definition/define.js'
export {
  estimateMessages,
  estimateText,
  estimateTools,
  nextCalibration,
} from './core/run/estimate.js'
export { layout, segmentToMessage } from './core/run/layout.js'
export type { ViewParts } from './core/run/layout.js'
export {
  DEFAULT_BUDGET,
  addUsage,
  apply,
  emptyRunUsage,
  emptyUsage,
  initial,
  nextStage,
} from './core/run/state.js'
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
export { costOf, runCost, stepFacts } from './core/supervision/facts.js'
export { classifyError } from './core/supervision/error-class.js'
export { budgetGuard } from './core/supervision/budget-guard.js'
export { renderFinding, renderSteering } from './core/supervision/steering.js'
export type { SteeringInput } from './core/supervision/steering.js'
export { budgetState, decide } from './core/supervision/decide.js'
export type { BudgetState, SourcedOpinion } from './core/supervision/decide.js'
export { checkInvariants } from './core/log/invariants.js'
export type { InvariantViolation } from './core/log/invariants.js'
export { REDACTED, redactText, redactValue } from './core/log/redact.js'
export { guardOpinionIssue, permitResultIssue } from './core/definition/component-results.js'
export { upcastEvent } from './core/log/upcast.js'
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
export { retrospective } from './core/log/retrospective.js'
export { strictReplay } from './core/log/replay.js'
export { seededRandom } from './core/run/random.js'
export type { StrictReplay } from './core/log/replay.js'
export type { RetrospectiveEntry, RunRetrospective } from './core/log/retrospective.js'
export type { SupervisionStats } from './core/supervision/supervision-stats.js'
export { buildTrace } from './core/log/trace.js'
export type { TraceNode } from './core/log/trace.js'

// 平台服务
export { memoryArchive } from './services/memory-archive.js'
export { systemClock } from './services/clock.js'
export { createBreaker } from './services/breaker.js'
export type { Breaker } from './services/breaker.js'
export { modelHub } from './services/model-hub.js'
export { skillHost } from './services/hosts/skill-host.js'
export type { SkillHost, SkillPackage } from './services/hosts/skill-host.js'
export { delegationHost } from './services/hosts/delegation-host.js'
export { createMcpHost } from './services/hosts/mcp-host.js'
export { createHookRunner } from './services/hosts/hook-runner.js'
export type { HookResult, HookRunner } from './services/hosts/hook-runner.js'
export type { McpHost, McpLease } from './services/hosts/mcp-host.js'
export type { DelegationHost, SubagentSpec } from './services/hosts/delegation-host.js'
export type { ModelHubOptions } from './services/model-hub.js'
export { AdmissionTimeoutError, createAdmission } from './services/admission.js'
export type { Admission, AdmissionSlot } from './services/admission.js'

// 引擎装配（默认组件由调用方给出；带标准组件的 createEngine 在 index.ts，方案 D10）
export { assembleEngine } from './engine/engine.js'
export { regressionReplay } from './engine/replay.js'
export type { RegressionInput, RegressionReport } from './engine/replay.js'
export type { EngineDefaults } from './engine/engine.js'
