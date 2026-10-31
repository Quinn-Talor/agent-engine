// 用量归一（设计 §8.1）：优先读 inputTokenDetails，读不到再扫描 providerMetadata，统一为
// { input, output, cacheRead, cacheWrite }。四项是加法关系：input 为未命中缓存的输入。

import type { LanguageModelUsage, ProviderMetadata } from 'ai'
import type { NormalizedUsage } from '../../api.js'

const numberAt = (
  metadata: ProviderMetadata | undefined,
  vendor: string,
  key: string,
): number | undefined => {
  const value = metadata?.[vendor]?.[key]
  return typeof value === 'number' ? value : undefined
}

export function normalizeUsage(
  usage: LanguageModelUsage | undefined,
  metadata: ProviderMetadata | undefined,
): NormalizedUsage {
  const details = usage?.inputTokenDetails
  const cacheRead =
    details?.cacheReadTokens ??
    numberAt(metadata, 'anthropic', 'cacheReadInputTokens') ??
    numberAt(metadata, 'openai', 'cachedPromptTokens') ??
    0
  const cacheWrite =
    details?.cacheWriteTokens ?? numberAt(metadata, 'anthropic', 'cacheCreationInputTokens') ?? 0
  const input =
    details?.noCacheTokens ?? Math.max(0, (usage?.inputTokens ?? 0) - cacheRead - cacheWrite)
  return { input, output: usage?.outputTokens ?? 0, cacheRead, cacheWrite }
}
