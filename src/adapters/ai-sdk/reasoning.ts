// reasoning 参数（设计 §8.1）：Anthropic thinking 预算 2048 / 4096 / 8192；OpenAI reasoningEffort 并开启
// parallelToolCalls；Google thinkingConfig，关闭时为 0；Ollama think。不配置时不注入推理参数，
// 只有选择关闭时才注入关闭参数（强制开启 thinking 的模型据此关闭）。

export type Vendor = 'anthropic' | 'openai' | 'google' | 'ollama' | 'other'
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high'

const BUDGET = { low: 2048, medium: 4096, high: 8192 } as const

export function reasoningOptions(
  vendor: Vendor,
  level: ReasoningLevel | undefined,
): Record<string, Record<string, unknown>> | undefined {
  const on = level !== undefined && level !== 'off'
  switch (vendor) {
    case 'anthropic':
      if (on) return { anthropic: { thinking: { type: 'enabled', budgetTokens: BUDGET[level] } } }
      return level === 'off' ? { anthropic: { thinking: { type: 'disabled' } } } : undefined
    case 'openai':
      return { openai: { ...(on ? { reasoningEffort: level } : {}), parallelToolCalls: true } }
    case 'google':
      if (level === undefined) return undefined
      return { google: { thinkingConfig: { thinkingBudget: on ? BUDGET[level] : 0 } } }
    case 'ollama':
      return level === undefined ? undefined : { ollama: { think: on } }
    case 'other':
      return undefined
  }
}
