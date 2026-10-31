// 引擎契约：平台服务与运行机制的装配、健康状态（设计 §1.2、§2）。

import type { CapabilityHost } from './capability.js'
import type { Clock, Logger, SecretResolver } from './common.js'
import type { Guard, Memory } from './component.js'
import type { EnvironmentConfig, Environment } from './environment.js'
import type { Archive } from './events.js'
import type { ModelHub } from './model.js'
import type { RunSummary } from './run.js'

/** 凭据库：按引用解析凭据。 */
export type Vault = SecretResolver

export interface BreakerStatus {
  /** 模型：提供方 + 模型；MCP：服务器规格的指纹；工具：能力 id + 工具名。 */
  key: string
  dependency: 'model' | 'mcp' | 'tool'
  state: 'closed' | 'open' | 'half_open'
  since: number
}

export interface EngineHealth {
  breakers: BreakerStatus[]
  admission: { running: number; queued: number }
}

export interface EngineConfig {
  services: {
    models: ModelHub
    /** 加在默认宿主（skill 宿主、委托调度）之外；同一种类的替换默认的。 */
    hosts?: CapabilityHost[]
    /** 默认内存实现；持久化用 sqliteArchive。 */
    archive?: Archive
    /** 不提供时，带凭据引用的能力无法准备。 */
    vault?: Vault
    clock?: Clock
    /** 诊断日志；默认输出到控制台。 */
    logger?: Logger
    admission?: { maxConcurrentRuns?: number; queueTimeoutMs?: number }
  }
  /** 记忆策略；默认 compactingMemory()。 */
  memory?: Memory
  /** 引擎的守卫，来源为 `engine:<id>`；默认 standardGuards()，[] 表示不用标准守卫。 */
  guards?: Guard[]
}

export interface Engine {
  environment(config: EnvironmentConfig): Environment
  /** 记忆、监督、默认交付物与默认工具呈现的指纹。 */
  readonly fingerprint: string
  /** 本次启动时补齐结尾的中断运行，由应用决定是否接着做。 */
  interrupted(): Promise<RunSummary[]>
  health(): EngineHealth
  onHealth(fn: (h: EngineHealth) => void): () => void
  shutdown(): Promise<void>
}
