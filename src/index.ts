// 包入口：应用 API、标准组件、不依赖外部库的适配器，以及带默认组件的 createEngine（方案 D10）。
// 依赖外部库的适配器（ai、better-sqlite3、MCP SDK）和测试工具走子路径导出，主入口不加载它们。

import { assembleEngine, createHookRunner, createMcpHost } from './api.js'
import type { Engine, EngineConfig, HookRunner, McpConnect, McpHost } from './api.js'
import { consoleLogger } from './adapters/console-logger/console-logger.js'
import { processExec } from './adapters/hook-process/hook-process.js'
import { completionReview } from './stdlib/checks/completion-review.js'
import { standardFallback } from './stdlib/delivery/standard-fallback.js'
import { text } from './stdlib/delivery/output-contracts.js'
import { searchExposure } from './stdlib/exposure/search-exposure.js'
import { compactingMemory } from './stdlib/memory/compacting-memory.js'
import { standardGuards } from './stdlib/supervision/standard-guards.js'

export * from './api.js'

/**
 * 按传输方式分派到官方 SDK 的 stdio / Streamable HTTP 适配器。
 * 第一次连接时才加载：MCP SDK 是可选的 peer 依赖，不用 MCP 的应用不必安装。
 */
const mcpConnect: McpConnect = async (server, opts) =>
  server.transport.kind === 'stdio'
    ? (await import('./adapters/mcp-stdio/mcp-stdio.js')).stdioConnect(server, opts)
    : (await import('./adapters/mcp-http/mcp-http.js')).httpConnect(server, opts)

/** 用子进程执行 hook 的 hook 执行器（设计 §8.3）。 */
export function hookRunner(): HookRunner {
  return createHookRunner({ exec: processExec })
}

/** 带默认传输适配器的 MCP 连接池（设计 §8.3、§12.2）。 */
export function mcpHost(opts: Omit<Parameters<typeof createMcpHost>[0], 'connect'> = {}): McpHost {
  return createMcpHost({ ...opts, connect: mcpConnect })
}

/**
 * 带默认组件的引擎（设计 §2）：记忆、守卫、交付物、工具呈现、诊断日志缺省时用标准组件。
 * 默认交付物带完成审查：风险分够高才多调一次模型。
 */
export function createEngine(config: EngineConfig): Engine {
  return assembleEngine(config, {
    memory: compactingMemory(),
    guards: standardGuards(),
    deliverable: { output: text(), checks: [completionReview()], fallback: standardFallback() },
    exposure: searchExposure(),
    logger: consoleLogger(),
  })
}

// 标准组件
export { structured, text } from './stdlib/delivery/output-contracts.js'
export type { DomainValidate } from './stdlib/delivery/output-contracts.js'
export { FINALIZE_CODES, standardFallback } from './stdlib/delivery/standard-fallback.js'

export {
  DEFAULT_GUARD_THRESHOLDS,
  failureStreak,
  noNewInfo,
  silentProgress,
  standardGuards,
  truncation,
} from './stdlib/supervision/standard-guards.js'
export type { GuardThresholds } from './stdlib/supervision/standard-guards.js'
export { modelAdvisor } from './stdlib/supervision/advisor.js'
export type { AdvisorOptions } from './stdlib/supervision/advisor.js'
export { roadblock } from './stdlib/supervision/roadblock.js'
export { thresholdGuard } from './stdlib/supervision/threshold-guard.js'
export type { ThresholdGuardSpec } from './stdlib/supervision/threshold-guard.js'

export { bundle, tool, tools, toolsFingerprint } from './stdlib/capabilities/tools.js'
export { skill } from './stdlib/capabilities/skill.js'
export { subagent } from './stdlib/capabilities/subagent.js'
export { parseSkill } from './stdlib/claude-code/parse-skill.js'
export { mcp } from './stdlib/capabilities/mcp.js'
export { adaptHooks } from './stdlib/claude-code/adapt-hooks.js'
export type { HookToolView } from './stdlib/claude-code/adapt-hooks.js'
export { parseMcpConfig } from './stdlib/claude-code/parse-mcp-config.js'
export { parsePlugin } from './stdlib/claude-code/parse-plugin.js'
export type { ParsedPlugin } from './stdlib/claude-code/parse-plugin.js'
export { PLAN_PROGRESS } from './stdlib/capabilities/planning.js'
export { grounding } from './stdlib/checks/grounding.js'
export { groundingCheck } from './stdlib/checks/grounding-check.js'
export { completionReview, riskScore } from './stdlib/checks/completion-review.js'
export { BUILT_IN_SENSITIVE, workspaceSandbox } from './stdlib/permissions/workspace-sandbox.js'
export { riskApproval } from './stdlib/permissions/risk-approval.js'
export { retrospect } from './stdlib/retrospect/brief.js'
export { otelExporter } from './stdlib/observability/otel-exporter.js'
export type { OtelSpan } from './stdlib/observability/otel-exporter.js'
export { langfuseExporter } from './stdlib/observability/langfuse-exporter.js'
export type { LangfuseEvent } from './stdlib/observability/langfuse-exporter.js'
export { intents } from './stdlib/capabilities/intents.js'
export { planning, progressGuard } from './stdlib/capabilities/planning.js'
export { searchExposure } from './stdlib/exposure/search-exposure.js'
export type { SearchExposureOptions } from './stdlib/exposure/search-exposure.js'
export { bm25Ranker, tokenize } from './stdlib/exposure/tool-ranker.js'
export type { RankedTool, ToolCandidate, ToolRanker } from './stdlib/exposure/tool-ranker.js'
export { compactingMemory, cutIndex } from './stdlib/memory/compacting-memory.js'

// 适配器（不依赖外部库的；其余见 package.json 的 exports）
export { consoleLogger } from './adapters/console-logger/console-logger.js'
export { processExec } from './adapters/hook-process/hook-process.js'
