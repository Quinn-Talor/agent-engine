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

export { canonicalJson, hashOf, inputHash, sha256Hex } from './core/hash.js'
export {
  agentFingerprint,
  componentIdentity,
  engineFingerprint,
  environmentFingerprint,
  taskFingerprint,
} from './core/fingerprint.js'
export type { ComponentIdentity } from './core/fingerprint.js'
export { defineAgent, defineTask } from './core/define.js'
export { estimateMessages, estimateText, estimateTools, nextCalibration } from './core/estimate.js'
export { layout, segmentToMessage } from './core/layout.js'
export type { ViewParts } from './core/layout.js'
export {
  DEFAULT_BUDGET,
  addUsage,
  apply,
  emptyRunUsage,
  emptyUsage,
  initial,
  nextStage,
} from './core/state.js'
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
} from './core/state.js'
export { costOf, runCost, stepFacts } from './core/facts.js'
export { classifyError } from './core/error-class.js'
export { budgetGuard } from './core/budget-guard.js'
export { renderFinding, renderSteering } from './core/steering.js'
export type { SteeringInput } from './core/steering.js'
export { budgetState, decide } from './core/decide.js'
export type { BudgetState, SourcedOpinion } from './core/decide.js'
export { checkInvariants } from './core/invariants.js'
export type { InvariantViolation } from './core/invariants.js'
export { REDACTED, redactText, redactValue } from './core/redact.js'
export { guardOpinionIssue, permitResultIssue } from './core/component-results.js'
export { upcastEvent } from './core/upcast.js'
export {
  buildCorpus,
  deliveries,
  foldState,
  observations,
  qualityOf,
  sideEffects,
  summarize,
  transcriptMessages,
} from './core/projections.js'
export type { SideEffect } from './core/projections.js'
export { supervisionStats } from './core/supervision-stats.js'
export { retrospective } from './core/retrospective.js'
export { strictReplay } from './core/replay.js'
export { seededRandom } from './core/random.js'
export type { StrictReplay } from './core/replay.js'
export type { RetrospectiveEntry, RunRetrospective } from './core/retrospective.js'
export type { SupervisionStats } from './core/supervision-stats.js'
export { buildTrace } from './core/trace.js'
export type { TraceNode } from './core/trace.js'

// 平台服务
export { memoryArchive } from './services/memory-archive.js'
export { systemClock } from './services/clock.js'
export { createBreaker } from './services/breaker.js'
export type { Breaker } from './services/breaker.js'
export { modelHub } from './services/model-hub.js'
export { skillHost } from './services/skill-host.js'
export type { SkillHost, SkillPackage } from './services/skill-host.js'
export { delegationHost } from './services/delegation-host.js'
export { createMcpHost } from './services/mcp-host.js'
export { createHookRunner } from './services/hook-runner.js'
export type { HookResult, HookRunner } from './services/hook-runner.js'
export type { McpHost, McpLease } from './services/mcp-host.js'
export type { DelegationHost, SubagentSpec } from './services/delegation-host.js'
export type { ModelHubOptions } from './services/model-hub.js'
export { AdmissionTimeoutError, createAdmission } from './services/admission.js'
export type { Admission, AdmissionSlot } from './services/admission.js'

// 引擎装配（默认组件由调用方给出；带标准组件的 createEngine 在 index.ts，方案 D10）
export { assembleEngine } from './engine/engine.js'
export { regressionReplay } from './engine/replay.js'
export type { RegressionInput, RegressionReport } from './engine/replay.js'
export type { EngineDefaults } from './engine/engine.js'
