// 组件作者 API（`agent-engine/sdk`）：应用 API 加上实现组件、适配器、运行档案时用到的核心函数。
// `stdlib/`、`adapters/`、`testing/` 只经这里与 `contracts/` 取用引擎能力（方案 D10）；这些函数不从包入口导出。

export * from './api.js'

// 哈希与指纹
export { canonicalJson, hashOf, inputHash, sha256Hex } from './core/definition/hash.js'
export {
  agentFingerprint,
  componentIdentity,
  engineFingerprint,
  environmentFingerprint,
  taskFingerprint,
} from './core/definition/fingerprint.js'
export type { ComponentIdentity } from './core/definition/fingerprint.js'
export { guardOpinionIssue, permitResultIssue } from './core/definition/component-results.js'

// 运行状态机、视图与估算
export {
  DEFAULT_BUDGET,
  addUsage,
  apply,
  emptyRunUsage,
  emptyUsage,
  initial,
  nextStage,
} from './core/run/state.js'
export { layout, segmentToMessage } from './core/run/layout.js'
export type { ViewParts } from './core/run/layout.js'
export {
  estimateMessages,
  estimateText,
  estimateTools,
  nextCalibration,
} from './core/run/estimate.js'
export { seededRandom } from './core/run/random.js'

// 监督：事实、判定、纠偏
export { costOf, runCost, stepFacts } from './core/supervision/facts.js'
export { classifyError } from './core/supervision/error-class.js'
export { budgetGuard } from './core/supervision/budget-guard.js'
export { renderFinding, renderSteering } from './core/supervision/steering.js'
export type { SteeringInput } from './core/supervision/steering.js'
export { budgetState, decide } from './core/supervision/decide.js'
export type { BudgetState, SourcedOpinion } from './core/supervision/decide.js'

// 运行日志：不变量、脱敏、事件升级
export { checkInvariants } from './core/log/invariants.js'
export type { InvariantViolation } from './core/log/invariants.js'
export { REDACTED, redactText, redactValue } from './core/log/redact.js'
export { upcastEvent } from './core/log/upcast.js'

// 平台机制
export { createBreaker } from './services/breaker.js'
export type { Breaker } from './services/breaker.js'
export { AdmissionTimeoutError, createAdmission } from './services/admission.js'
export type { Admission, AdmissionSlot } from './services/admission.js'
